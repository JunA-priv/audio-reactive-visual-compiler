package audioanalysis

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/audiobudget"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/authn"
	"github.com/labstack/echo/v5"
)

const validTimeline = `{"schemaVersion":1,"analysisVersion":"python-island/test","sampleRateHz":44100,"timeUnit":"ms","durationMs":1000,"bassEnvelope":[{"timeMs":0,"value":0.2},{"timeMs":1000,"value":0.4}],"kickEvents":[]}`
const validSummary = `{"summaryVersion":1,"durationMs":1000,"sourceAudio":{"format":"wav","codec":"pcm_s16le","sampleRateHz":44100,"channels":2,"fileBytes":100},"analysis":{"model":"scnet_standard","device":"cpu","stemRms":{"drums":0.1,"bass":0.1,"vocals":0.1,"other":0.1},"estimatedKickCount":0,"featureSampleRateHz":100,"kickDetection":"fixture"}}`
const validMetadata = `{"metadataVersion":1,"runtime":{"inputDurationSeconds":1}}`

type fakeProber struct {
	info WAVInfo
	err  error
}

func (p fakeProber) Probe(context.Context, string) (WAVInfo, error) { return p.info, p.err }

type fakeRunner struct {
	started  chan struct{}
	release  chan struct{}
	err      error
	waitCtx  bool
	gateMode string
	model    string
}

type fakeAdmission struct {
	mu           sync.Mutex
	reserveErr   error
	startErr     error
	releaseErr   error
	settleErr    error
	reserveCalls int
	users        []string
	starts       []string
	releases     []string
	settlements  []struct{ id, state, code string }
}

func (s *fakeAdmission) Reserve(_ context.Context, user string) (audiobudget.Reservation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reserveCalls++
	s.users = append(s.users, user)
	if s.reserveErr != nil {
		return audiobudget.Reservation{}, s.reserveErr
	}
	return audiobudget.Reservation{ID: fmt.Sprintf("reservation-%d", s.reserveCalls)}, nil
}
func (s *fakeAdmission) Start(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.starts = append(s.starts, id)
	return s.startErr
}
func (s *fakeAdmission) Release(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.releases = append(s.releases, id)
	return s.releaseErr
}
func (s *fakeAdmission) Settle(_ context.Context, id, state, code string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.settlements = append(s.settlements, struct{ id, state, code string }{id, state, code})
	return s.settleErr
}
func (*fakeAdmission) Close() {}

func (r *fakeRunner) Analyze(ctx context.Context, _ string, output string, gateMode string) error {
	r.gateMode = gateMode
	if r.started != nil {
		select {
		case r.started <- struct{}{}:
		default:
		}
	}
	if r.waitCtx {
		<-ctx.Done()
		return ctx.Err()
	}
	if r.release != nil {
		<-r.release
	}
	if r.err != nil {
		return r.err
	}
	if err := os.WriteFile(filepath.Join(output, "feature-timeline.json"), []byte(validTimeline), 0600); err != nil {
		return err
	}
	summary := validSummary
	if r.model != "" {
		summary = strings.Replace(summary, `"model":"scnet_standard"`, `"model":"`+r.model+`"`, 1)
	}
	if err := os.WriteFile(filepath.Join(output, "music-summary.json"), []byte(summary), 0600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(output, "analysis-metadata.json"), []byte(validMetadata), 0600)
}

func TestAnalyzeAcceptsStandardAndDevelopmentModelIdentifiers(t *testing.T) {
	for _, model := range []string{"scnet_standard", "htdemucs"} {
		t.Run(model, func(t *testing.T) {
			runner := &fakeRunner{model: model}
			e, _ := testHandler(t, runner, validInfo(), time.Second)
			contentType, body := makeMultipart(t, 100)
			if response := doRequest(e, contentType, body, "Bearer valid"); response.Code != http.StatusOK {
				t.Fatalf("model %s was rejected: status=%d body=%s", model, response.Code, response.Body.String())
			}
		})
	}
	runner := &fakeRunner{model: "unknown"}
	e, _ := testHandler(t, runner, validInfo(), time.Second)
	contentType, body := makeMultipart(t, 100)
	if response := doRequest(e, contentType, body, "Bearer valid"); response.Code != http.StatusBadGateway {
		t.Fatalf("unknown model was accepted: status=%d body=%s", response.Code, response.Body.String())
	}
}

func testHandler(t *testing.T, runner Runner, info WAVInfo, timeout time.Duration) (*echo.Echo, string) {
	return testHandlerWithAdmission(t, runner, info, timeout, &fakeAdmission{})
}

func testHandlerWithAdmission(t *testing.T, runner Runner, info WAVInfo, timeout time.Duration, admission audiobudget.Store) (*echo.Echo, string) {
	t.Helper()
	temp := t.TempDir()
	h, err := NewHandler(Config{TempDirectory: temp, Timeout: timeout, Prober: fakeProber{info: info}, Runner: runner, Admission: admission})
	if err != nil {
		t.Fatal(err)
	}
	e := echo.New()
	auth := func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			if c.Request().Header.Get(echo.HeaderAuthorization) != "Bearer valid" {
				return c.NoContent(http.StatusUnauthorized)
			}
			c.SetRequest(c.Request().WithContext(authn.ContextWithPrincipal(c.Request().Context(), authn.Principal{Subject: "00000000-0000-4000-8000-000000000001"})))
			return next(c)
		}
	}
	h.Register(e, auth)
	return e, temp
}

func makeMultipart(t *testing.T, size int) (string, []byte) {
	return makeMultipartWithGateMode(t, size, "")
}

func makeMultipartWithGateMode(t *testing.T, size int, gateMode string) (string, []byte) {
	t.Helper()
	var body strings.Builder
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile("audio", "selected.wav")
	if err != nil {
		t.Fatal(err)
	}
	if size < 1 {
		size = 48
	}
	if _, err := io.Copy(part, strings.NewReader(strings.Repeat("w", size))); err != nil {
		t.Fatal(err)
	}
	if gateMode != "" {
		if err := w.WriteField("kickGateMode", gateMode); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return w.FormDataContentType(), []byte(body.String())
}

func doRequest(e *echo.Echo, contentType string, body []byte, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/audio/analyze", strings.NewReader(string(body)))
	r.Header.Set(echo.HeaderContentType, contentType)
	if token != "" {
		r.Header.Set(echo.HeaderAuthorization, token)
	}
	w := httptest.NewRecorder()
	e.ServeHTTP(w, r)
	return w
}

func validInfo() WAVInfo {
	return WAVInfo{Format: "wav", Codec: "pcm_s16le", SampleRate: 44100, Channels: 2, DurationSeconds: 1}
}

func TestAnalyzeReturnsValidatedV1OutputAndCleansPrivateTemp(t *testing.T) {
	runner := &fakeRunner{}
	admission := &fakeAdmission{}
	e, temp := testHandlerWithAdmission(t, runner, validInfo(), time.Second, admission)
	contentType, body := makeMultipart(t, 100)
	w := doRequest(e, contentType, body, "Bearer valid")
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if runner.gateMode != "hard" {
		t.Fatalf("omitted kickGateMode should default to hard, got %q", runner.gateMode)
	}
	if len(admission.starts) != 1 || len(admission.settlements) != 1 || admission.settlements[0].state != audiobudget.StateSucceeded || len(admission.releases) != 0 {
		t.Fatalf("successful reservation lifecycle is wrong: starts=%v settled=%v released=%v", admission.starts, admission.settlements, admission.releases)
	}
	if !strings.Contains(w.Body.String(), `"featureTimeline"`) || !strings.Contains(w.Body.String(), `"musicSummary"`) || !strings.Contains(w.Body.String(), `"analysisMetadata"`) {
		t.Fatalf("missing analysis outputs: %s", w.Body.String())
	}
	entries, err := os.ReadDir(temp)
	if err != nil || len(entries) != 0 {
		t.Fatalf("private temp files were not removed: entries=%d err=%v", len(entries), err)
	}
}

func TestAnalyzeKeepsUserAndRequestStateIsolated(t *testing.T) {
	users := []string{
		"00000000-0000-4000-8000-000000000001",
		"00000000-0000-4000-8000-000000000002",
	}
	var pathsMu sync.Mutex
	var inputPaths, outputPaths []string
	runner := runnerFunc(func(ctx context.Context, input, output, gate string) error {
		pathsMu.Lock()
		inputPaths = append(inputPaths, input)
		outputPaths = append(outputPaths, output)
		pathsMu.Unlock()
		return (&fakeRunner{}).Analyze(ctx, input, output, gate)
	})
	admission := &fakeAdmission{}
	h, err := NewHandler(Config{TempDirectory: t.TempDir(), Timeout: time.Second, Prober: fakeProber{info: validInfo()}, Runner: runner, Admission: admission})
	if err != nil {
		t.Fatal(err)
	}
	e := echo.New()
	auth := func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			subject := map[string]string{"Bearer user-a": users[0], "Bearer user-b": users[1]}[c.Request().Header.Get(echo.HeaderAuthorization)]
			if subject == "" {
				return c.NoContent(http.StatusUnauthorized)
			}
			c.SetRequest(c.Request().WithContext(authn.ContextWithPrincipal(c.Request().Context(), authn.Principal{Subject: subject})))
			return next(c)
		}
	}
	h.Register(e, auth)
	contentType, body := makeMultipart(t, 100)
	for _, token := range []string{"Bearer user-a", "Bearer user-b"} {
		if got := doRequest(e, contentType, body, token).Code; got != http.StatusOK {
			t.Fatalf("request for %s failed with status %d", token, got)
		}
	}
	if len(admission.users) != 2 || admission.users[0] != users[0] || admission.users[1] != users[1] {
		t.Fatalf("verified users crossed request boundaries: %v", admission.users)
	}
	if len(inputPaths) != 2 || inputPaths[0] == inputPaths[1] || filepath.Dir(inputPaths[0]) == filepath.Dir(inputPaths[1]) {
		t.Fatalf("input files did not use separate request directories: %v", inputPaths)
	}
	if len(outputPaths) != 2 || outputPaths[0] == outputPaths[1] || filepath.Dir(outputPaths[0]) == filepath.Dir(outputPaths[1]) {
		t.Fatalf("analysis outputs did not use separate request directories: %v", outputPaths)
	}
}

type runnerFunc func(context.Context, string, string, string) error

func (f runnerFunc) Analyze(ctx context.Context, input, output, gate string) error {
	return f(ctx, input, output, gate)
}

func TestAdmissionRejectsBeforeReadingBodyOrStartingAnalysis(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
	}{
		{"not entitled", audiobudget.ErrNotEntitled, http.StatusForbidden},
		{"quota", audiobudget.ErrQuotaExceeded, http.StatusTooManyRequests},
		{"concurrency", audiobudget.ErrConcurrency, http.StatusTooManyRequests},
		{"burst", audiobudget.ErrRateLimited, http.StatusTooManyRequests},
		{"disabled", audiobudget.ErrDisabled, http.StatusServiceUnavailable},
		{"database", audiobudget.ErrUnavailable, http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &fakeAdmission{reserveErr: tc.err}
			runner := &fakeRunner{}
			e, _ := testHandlerWithAdmission(t, runner, validInfo(), time.Second, a)
			contentType, body := makeMultipart(t, 100)
			w := doRequest(e, contentType, body, "Bearer valid")
			if w.Code != tc.status || a.startErr != nil || len(a.starts) != 0 || runner.started != nil {
				t.Fatalf("admission rejection status=%d starts=%v", w.Code, a.starts)
			}
		})
	}
}

func TestNotEntitledDrainsOnlyBoundedAuthenticatedBodyBefore403(t *testing.T) {
	const requestBytes = 10 << 20
	admission := &fakeAdmission{reserveErr: audiobudget.ErrNotEntitled}
	e, _ := testHandlerWithAdmission(t, &fakeRunner{}, validInfo(), time.Second, admission)
	body := bytes.Repeat([]byte("w"), requestBytes)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/audio/analyze", bytes.NewReader(body))
	r.Header.Set(echo.HeaderContentType, "multipart/form-data; boundary=test")
	r.Header.Set(echo.HeaderAuthorization, "Bearer valid")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), `"analysis_not_entitled"`) {
		t.Fatalf("expired entitlement response status=%d body=%s", w.Code, w.Body.String())
	}
	remaining, err := io.ReadAll(r.Body)
	if err != nil || len(remaining) != 0 {
		t.Fatalf("bounded authenticated body was not drained: remaining=%d err=%v", len(remaining), err)
	}
	if admission.reserveCalls != 1 || len(admission.starts) != 0 || len(admission.settlements) != 0 {
		t.Fatalf("rejected entitlement changed quota lifecycle: reserve=%d starts=%v settlements=%v", admission.reserveCalls, admission.starts, admission.settlements)
	}
}

func TestNotEntitledDoesNotDrainDeclaredOversizedBody(t *testing.T) {
	admission := &fakeAdmission{reserveErr: audiobudget.ErrNotEntitled}
	e, _ := testHandlerWithAdmission(t, &fakeRunner{}, validInfo(), time.Second, admission)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/audio/analyze", strings.NewReader("body"))
	r.ContentLength = MaxRequestBytes + 1
	r.Header.Set(echo.HeaderContentType, "multipart/form-data; boundary=test")
	r.Header.Set(echo.HeaderAuthorization, "Bearer valid")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("oversized rejected entitlement status=%d body=%s", w.Code, w.Body.String())
	}
	remaining, err := io.ReadAll(r.Body)
	if err != nil || string(remaining) != "body" {
		t.Fatalf("declared oversized body should not be drained: remaining=%q err=%v", remaining, err)
	}
}

func TestMissingStoreFailsClosedAndJWTRejectionPrecedesReservation(t *testing.T) {
	contentType, body := makeMultipart(t, 100)
	e, _ := testHandlerWithAdmission(t, &fakeRunner{}, validInfo(), time.Second, nil)
	if got := doRequest(e, contentType, body, "Bearer valid").Code; got != http.StatusServiceUnavailable {
		t.Fatalf("missing admission store status=%d", got)
	}

	a := &fakeAdmission{}
	h, err := NewHandler(Config{TempDirectory: t.TempDir(), Prober: fakeProber{info: validInfo()}, Runner: &fakeRunner{}, Admission: a})
	if err != nil {
		t.Fatal(err)
	}
	e = echo.New()
	reject := func(echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error { return c.NoContent(http.StatusUnauthorized) }
	}
	h.Register(e, reject)
	if got := doRequest(e, contentType, body, "Bearer invalid").Code; got != http.StatusUnauthorized || a.reserveCalls != 0 {
		t.Fatalf("JWT rejection reached reservation: status=%d reserve_calls=%d", got, a.reserveCalls)
	}
}

func TestPreStartValidationReleasesWithoutCharging(t *testing.T) {
	a := &fakeAdmission{}
	e, _ := testHandlerWithAdmission(t, &fakeRunner{}, WAVInfo{Format: "wav", Codec: "pcm_s16le", SampleRate: 44100, Channels: 1, DurationSeconds: 1}, time.Second, a)
	contentType, body := makeMultipart(t, 100)
	w := doRequest(e, contentType, body, "Bearer valid")
	if w.Code != http.StatusUnprocessableEntity || len(a.starts) != 0 || len(a.settlements) != 0 || len(a.releases) != 1 {
		t.Fatalf("pre-start rejection lifecycle status=%d starts=%v settled=%v released=%v", w.Code, a.starts, a.settlements, a.releases)
	}
}

func TestStartFailureAndSettlementFailureFailClosed(t *testing.T) {
	contentType, body := makeMultipart(t, 100)
	startFailure := &fakeAdmission{startErr: audiobudget.ErrQuotaExceeded}
	runner := &fakeRunner{}
	e, _ := testHandlerWithAdmission(t, runner, validInfo(), time.Second, startFailure)
	w := doRequest(e, contentType, body, "Bearer valid")
	if w.Code != http.StatusTooManyRequests || len(startFailure.releases) != 1 || len(startFailure.settlements) != 0 {
		t.Fatalf("start failure lifecycle status=%d", w.Code)
	}

	settleFailure := &fakeAdmission{settleErr: audiobudget.ErrUnavailable}
	e, _ = testHandlerWithAdmission(t, &fakeRunner{}, validInfo(), time.Second, settleFailure)
	w = doRequest(e, contentType, body, "Bearer valid")
	if w.Code != http.StatusServiceUnavailable || len(settleFailure.starts) != 1 || len(settleFailure.settlements) < 1 {
		t.Fatalf("settlement failure did not fail closed: status=%d", w.Code)
	}
}

func TestAnalyzePassesValidKickGateModeAndRejectsInvalidMode(t *testing.T) {
	for _, mode := range []string{"off", "soft", "middle", "hard"} {
		t.Run(mode, func(t *testing.T) {
			runner := &fakeRunner{}
			e, _ := testHandler(t, runner, validInfo(), time.Second)
			contentType, body := makeMultipartWithGateMode(t, 100, mode)
			w := doRequest(e, contentType, body, "Bearer valid")
			if w.Code != http.StatusOK || runner.gateMode != mode {
				t.Fatalf("mode not propagated: status=%d got=%q body=%s", w.Code, runner.gateMode, w.Body.String())
			}
		})
	}
	e, _ := testHandler(t, &fakeRunner{}, validInfo(), time.Second)
	contentType, body := makeMultipartWithGateMode(t, 100, "unrestricted")
	if w := doRequest(e, contentType, body, "Bearer valid"); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid mode status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestPythonIslandArgumentsIncludeSelectedKickGateMode(t *testing.T) {
	want := []string{"clip.wav", "--output-dir", "out", "--threads", "4", "--kick-gate-mode", "soft"}
	got := pythonIslandArgs("clip.wav", "out", "soft", 4)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Python Island arguments=%v want=%v", got, want)
	}
}

type sizedClipRunner struct{ inputBytes int64 }

func (r *sizedClipRunner) Analyze(_ context.Context, input, output, _ string) error {
	info, err := os.Stat(input)
	if err != nil {
		return err
	}
	r.inputBytes = info.Size()
	timeline := strings.Replace(validTimeline, `"durationMs":1000`, `"durationMs":60000`, 1)
	summary := strings.Replace(validSummary, `"durationMs":1000`, `"durationMs":60000`, 1)
	summary = strings.Replace(summary, `"fileBytes":100`, fmt.Sprintf(`"fileBytes":%d`, info.Size()), 1)
	for name, value := range map[string]string{
		"feature-timeline.json":  timeline,
		"music-summary.json":     summary,
		"analysis-metadata.json": validMetadata,
	} {
		if err := os.WriteFile(filepath.Join(output, name), []byte(value), 0600); err != nil {
			return err
		}
	}
	return nil
}

func TestAnalyzeReceivesTenPointSixMBSixtySecondWAV(t *testing.T) {
	clip := makePCM16WAV(60 * 44_100)
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("audio", "selected-clip.wav")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(clip); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	if len(clip) != 10_584_044 || body.Len() >= MaxRequestBytes {
		t.Fatalf("unexpected fixture sizes: wav=%d request=%d", len(clip), body.Len())
	}

	runner := &sizedClipRunner{}
	e, temp := testHandler(t, runner, WAVInfo{Format: "wav", Codec: "pcm_s16le", SampleRate: 44_100, Channels: 2, DurationSeconds: 60}, time.Second)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/audio/analyze", &body)
	req.Header.Set(echo.HeaderContentType, form.FormDataContentType())
	req.Header.Set(echo.HeaderAuthorization, "Bearer valid")
	response := httptest.NewRecorder()
	e.ServeHTTP(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("60-second fixture status=%d body=%s", response.Code, response.Body.String())
	}
	if runner.inputBytes != int64(len(clip)) {
		t.Fatalf("Go received %d audio bytes, want %d", runner.inputBytes, len(clip))
	}
	entries, err := os.ReadDir(temp)
	if err != nil || len(entries) != 0 {
		t.Fatalf("60-second analysis temp files remained: entries=%d err=%v", len(entries), err)
	}
}

func TestRegisterLogsRequestEvenWhenAuthRejectsBeforeBodyRead(t *testing.T) {
	var logs bytes.Buffer
	h, err := NewHandler(Config{
		TempDirectory: t.TempDir(),
		Prober:        fakeProber{info: validInfo()},
		Runner:        &fakeRunner{},
		Logger:        slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	e := echo.New()
	rejectAuth := func(echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error { return c.NoContent(http.StatusUnauthorized) }
	}
	h.Register(e, rejectAuth)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/audio/analyze", strings.NewReader("multipart body"))
	req.Header.Set(echo.HeaderContentType, "multipart/form-data; boundary=stub")
	response := httptest.NewRecorder()
	e.ServeHTTP(response, req)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unexpected auth status: %d", response.Code)
	}
	if !strings.Contains(logs.String(), "audio analysis HTTP request received") || !strings.Contains(logs.String(), "status=401") || !strings.Contains(logs.String(), "content_length=14") {
		t.Fatalf("request arrival/auth rejection was not logged safely: %s", logs.String())
	}
}

func TestAnalyzeRequiresJWTAndStrictValidWAV(t *testing.T) {
	e, _ := testHandler(t, &fakeRunner{}, validInfo(), time.Second)
	contentType, body := makeMultipart(t, 100)
	if got := doRequest(e, contentType, body, "").Code; got != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d", got)
	}
	invalid := validInfo()
	invalid.Channels = 1
	e, _ = testHandler(t, &fakeRunner{}, invalid, time.Second)
	if got := doRequest(e, contentType, body, "Bearer valid").Code; got != http.StatusUnprocessableEntity {
		t.Fatalf("invalid WAV status=%d", got)
	}
	e, _ = testHandler(t, &fakeRunner{}, WAVInfo{}, time.Second)
	if got := doRequest(e, contentType, body, "Bearer valid").Code; got != http.StatusUnprocessableEntity {
		t.Fatalf("unprobeable WAV status=%d", got)
	}
}

func TestCleanupOrphanedAnalysisTempsOnlyRemovesOldFeatureDirectories(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	oldAnalysis := filepath.Join(root, "arvc-audio-analysis-old")
	oldUpload := filepath.Join(root, "arvc-audio-job-upload-old")
	freshAnalysis := filepath.Join(root, "arvc-audio-analysis-fresh")
	unrelated := filepath.Join(root, "other-private-data")
	for _, dir := range []string{oldAnalysis, oldUpload, freshAnalysis, unrelated} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	old := now.Add(-orphanTempAge - time.Second)
	for _, dir := range []string{oldAnalysis, oldUpload} {
		if err := os.Chtimes(dir, old, old); err != nil {
			t.Fatal(err)
		}
	}
	if got := cleanupOrphanedAnalysisTemps(root, now); got != 2 {
		t.Fatalf("removed %d stale directories, want 2", got)
	}
	for _, dir := range []string{oldAnalysis, oldUpload} {
		if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("stale work directory remains: %s err=%v", filepath.Base(dir), err)
		}
	}
	for _, dir := range []string{freshAnalysis, unrelated} {
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			t.Fatalf("non-stale or unrelated directory changed: %s err=%v", filepath.Base(dir), err)
		}
	}
}

func TestAnalyzeMapsPythonFailureToSanitized502AndCleansFiles(t *testing.T) {
	a := &fakeAdmission{}
	e, temp := testHandlerWithAdmission(t, &fakeRunner{err: errors.New("private process diagnostic")}, validInfo(), time.Second, a)
	contentType, body := makeMultipart(t, 100)
	w := doRequest(e, contentType, body, "Bearer valid")
	if w.Code != http.StatusBadGateway || strings.Contains(w.Body.String(), "private process diagnostic") {
		t.Fatalf("Python failure was not safely mapped: status=%d", w.Code)
	}
	if len(a.settlements) != 1 || a.settlements[0].state != audiobudget.StateFailed {
		t.Fatalf("failed inference settlement=%v", a.settlements)
	}
	entries, err := os.ReadDir(temp)
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed analysis temp files remained: entries=%d err=%v", len(entries), err)
	}
}

func TestAnalyzeRejectsClipOver60SecondsAndOversizedRequest(t *testing.T) {
	contentType, body := makeMultipart(t, 100)
	long := validInfo()
	long.DurationSeconds = 60.001
	e, _ := testHandler(t, &fakeRunner{}, long, time.Second)
	if got := doRequest(e, contentType, body, "Bearer valid").Code; got != http.StatusUnprocessableEntity {
		t.Fatalf("long WAV status=%d", got)
	}
	e, _ = testHandler(t, &fakeRunner{}, validInfo(), time.Second)
	largeType, largeBody := makeMultipart(t, MaxRequestBytes)
	if got := doRequest(e, largeType, largeBody, "Bearer valid").Code; got != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize status=%d", got)
	}
}

func TestAnalyzeReturns429WhenGlobalSlotIsOccupied(t *testing.T) {
	runner := &fakeRunner{started: make(chan struct{}, 1), release: make(chan struct{})}
	e, _ := testHandler(t, runner, validInfo(), 3*time.Second)
	contentType, body := makeMultipart(t, 100)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- doRequest(e, contentType, body, "Bearer valid") }()
	select {
	case <-runner.started:
	case <-time.After(time.Second):
		t.Fatal("analysis runner did not start")
	}
	if got := doRequest(e, contentType, body, "Bearer valid").Code; got != http.StatusTooManyRequests {
		t.Fatalf("concurrent request status=%d", got)
	}
	close(runner.release)
	if got := (<-done).Code; got != http.StatusOK {
		t.Fatalf("first request status=%d", got)
	}
}

func TestAnalyzeTimeoutCleansTemporaryDirectory(t *testing.T) {
	runner := &fakeRunner{waitCtx: true}
	a := &fakeAdmission{}
	e, temp := testHandlerWithAdmission(t, runner, validInfo(), 20*time.Millisecond, a)
	contentType, body := makeMultipart(t, 100)
	w := doRequest(e, contentType, body, "Bearer valid")
	if w.Code != http.StatusGatewayTimeout {
		t.Fatalf("timeout status=%d body=%s", w.Code, w.Body.String())
	}
	if len(a.settlements) != 1 || a.settlements[0].state != audiobudget.StateFailed {
		t.Fatalf("timeout settlement=%v", a.settlements)
	}
	entries, err := os.ReadDir(temp)
	if err != nil || len(entries) != 0 {
		t.Fatalf("timeout temp files remained: entries=%d err=%v", len(entries), err)
	}
}

func TestAnalyzeRequestCancellationCleansTemporaryDirectory(t *testing.T) {
	runner := &fakeRunner{started: make(chan struct{}, 1), waitCtx: true}
	a := &fakeAdmission{}
	e, temp := testHandlerWithAdmission(t, runner, validInfo(), time.Second, a)
	contentType, body := makeMultipart(t, 100)
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/api/v1/audio/analyze", strings.NewReader(string(body))).WithContext(ctx)
	req.Header.Set(echo.HeaderContentType, contentType)
	req.Header.Set(echo.HeaderAuthorization, "Bearer valid")
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { response := httptest.NewRecorder(); e.ServeHTTP(response, req); done <- response }()
	select {
	case <-runner.started:
	case <-time.After(time.Second):
		cancel()
		t.Fatal("analysis runner did not start")
	}
	cancel()
	select {
	case response := <-done:
		if response.Code != 499 {
			t.Fatalf("canceled request status=%d", response.Code)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled analysis did not return")
	}
	if len(a.settlements) != 1 || a.settlements[0].state != audiobudget.StateCanceled {
		t.Fatalf("cancel settlement=%v", a.settlements)
	}
	entries, err := os.ReadDir(temp)
	if err != nil || len(entries) != 0 {
		t.Fatalf("canceled request temp files remained: entries=%d err=%v", len(entries), err)
	}
}

type blockedUploadBody struct {
	ctx     context.Context
	prefix  []byte
	started chan struct{}
}

func (b *blockedUploadBody) Read(dst []byte) (int, error) {
	if len(b.prefix) > 0 {
		n := copy(dst, b.prefix)
		b.prefix = b.prefix[n:]
		return n, nil
	}
	select {
	case <-b.started:
	default:
		close(b.started)
	}
	<-b.ctx.Done()
	return 0, b.ctx.Err()
}

func (b *blockedUploadBody) Close() error { return nil }

func TestAnalyzeClientCancellationDuringUploadIsNotReportedAsInvalidAudio(t *testing.T) {
	a := &fakeAdmission{}
	e, temp := testHandlerWithAdmission(t, &fakeRunner{}, validInfo(), time.Second, a)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	boundary := "audio-analysis-boundary"
	prefix := fmt.Sprintf("--%s\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"selected.wav\"\r\nContent-Type: audio/wav\r\n\r\npartial", boundary)
	body := &blockedUploadBody{ctx: ctx, prefix: []byte(prefix), started: make(chan struct{})}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/audio/analyze", nil).WithContext(ctx)
	req.Body = body
	req.ContentLength = -1
	req.Header.Set(echo.HeaderContentType, "multipart/form-data; boundary="+boundary)
	req.Header.Set(echo.HeaderAuthorization, "Bearer valid")
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { e.ServeHTTP(response, req); close(done) }()
	select {
	case <-body.started:
	case <-time.After(time.Second):
		t.Fatal("upload body was not read")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("canceled upload did not return")
	}
	if response.Code == http.StatusUnprocessableEntity {
		t.Fatalf("canceled upload was incorrectly reported as invalid audio: %s", response.Body.String())
	}
	if len(a.starts) != 0 || len(a.settlements) != 0 || len(a.releases) != 1 {
		t.Fatalf("upload cancellation charged unexpectedly: starts=%v settlements=%v releases=%v", a.starts, a.settlements, a.releases)
	}
	entries, err := os.ReadDir(temp)
	if err != nil || len(entries) != 0 {
		t.Fatalf("canceled upload temp files remained: entries=%d err=%v", len(entries), err)
	}
}

func TestPythonProcessDetailsExposeExitCodeWithoutStderr(t *testing.T) {
	err := exec.Command("sh", "-c", "exit 7").Run()
	if err == nil {
		t.Fatal("expected a non-zero process exit")
	}
	attrs := pythonProcessDetails(err)
	if len(attrs) != 2 || attrs[0] != "python_exit_code" || attrs[1] != 7 {
		t.Fatalf("unexpected safe process diagnostics: %#v", attrs)
	}
}

func TestAnalyzeRejectsMalformedPythonOutput(t *testing.T) {
	runner := &outputRunner{timeline: []byte(validTimeline), summary: []byte(validSummary), metadata: []byte(`{"metadataVersion":2}`)}
	e, _ := testHandler(t, runner, validInfo(), time.Second)
	contentType, body := makeMultipart(t, 100)
	if got := doRequest(e, contentType, body, "Bearer valid").Code; got != http.StatusBadGateway {
		t.Fatalf("invalid output status=%d", got)
	}
}

type outputRunner struct{ timeline, summary, metadata []byte }

func (r *outputRunner) Analyze(_ context.Context, _, output, _ string) error {
	for name, data := range map[string][]byte{"feature-timeline.json": r.timeline, "music-summary.json": r.summary, "analysis-metadata.json": r.metadata} {
		if err := os.WriteFile(filepath.Join(output, name), data, 0600); err != nil {
			return err
		}
	}
	return nil
}
