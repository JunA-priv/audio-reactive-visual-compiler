package audioanalysis

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/audiojobs"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/authn"
	"github.com/labstack/echo/v5"
)

type fakeJobStore struct {
	job            audiojobs.Job
	submittedUser  string
	submittedKey   string
	finishedState  string
	finishedResult []byte
	quotaReserves  int
	quotaStarts    int
	quotaSettles   int
	quotaReleases  int
	quotaJobID     string
	quotaAttempt   int
}

type fakeStorageJobStore struct {
	*fakeJobStore
	intentID  string
	objectKey string
	stored    bool
}

func (s *fakeStorageJobStore) CreateStorageIntent(_ context.Context, user, key string, hash []byte, jobID string, size int, gate string) (string, string, string, error) {
	if user != "00000000-0000-4000-8000-000000000001" || key == "" || len(hash) != 32 || size != 100 || gate != "soft" {
		return "", "", "", errors.New("invalid test intent")
	}
	s.intentID = jobID
	s.objectKey = user + "/" + jobID + ".wav"
	return "upload", jobID, s.objectKey, nil
}
func (s *fakeStorageJobStore) SubmitStored(_ context.Context, user, key string, hash []byte, jobID, gate string) (string, bool, error) {
	if !s.stored || jobID != s.intentID {
		return "", false, errors.New("submit before Storage write")
	}
	s.submittedUser = user
	s.submittedKey = key
	s.job.KickGateMode = gate
	return "job-storage", false, nil
}
func (*fakeStorageJobStore) ClaimedObject(context.Context, string, int) (string, []byte, error) {
	return "", nil, nil
}
func (*fakeStorageJobStore) ClaimStorageCleanup(context.Context, int) ([]string, error) {
	return nil, nil
}
func (*fakeStorageJobStore) FinishStorageCleanup(context.Context, string) error        { return nil }
func (*fakeStorageJobStore) RetryStorageCleanup(context.Context, string, string) error { return nil }

type fakeAudioStorage struct {
	data    []byte
	key     string
	deleted []string
}

func (s *fakeAudioStorage) Put(_ context.Context, key string, data []byte) error {
	s.key = key
	s.data = append([]byte(nil), data...)
	return nil
}
func (s *fakeAudioStorage) Get(_ context.Context, key string) ([]byte, error) {
	if key != s.key {
		return nil, audiojobs.ErrNotFound
	}
	return append([]byte(nil), s.data...), nil
}
func (s *fakeAudioStorage) Delete(_ context.Context, key string) error {
	s.deleted = append(s.deleted, key)
	return nil
}

func (s *fakeJobStore) Submit(_ context.Context, user, key string, _ []byte, audio []byte, gate string) (string, bool, error) {
	s.submittedUser = user
	s.submittedKey = key
	s.job.Audio = audio
	s.job.KickGateMode = gate
	return "job-1", false, nil
}
func (s *fakeJobStore) GetStatus(_ context.Context, id, user string) (audiojobs.Job, error) {
	if id != s.job.ID || user != s.job.UserID {
		return audiojobs.Job{}, audiojobs.ErrNotFound
	}
	return s.job, nil
}
func (s *fakeJobStore) GetResult(_ context.Context, id, user string) ([]byte, error) {
	if id != s.job.ID || user != s.job.UserID {
		return nil, audiojobs.ErrNotFound
	}
	return s.job.Result, nil
}
func (s *fakeJobStore) Cancel(context.Context, string, string) (string, error) {
	return "cancel_requested", nil
}
func (s *fakeJobStore) Claim(context.Context) (audiojobs.Job, bool, error) { return s.job, true, nil }
func (s *fakeJobStore) CancelRequested(context.Context, string, string) (bool, error) {
	return false, nil
}
func (s *fakeJobStore) FinishAttempt(_ context.Context, _ string, _ int, state string, result []byte, _ string) error {
	s.finishedState = state
	s.finishedResult = result
	return nil
}
func (*fakeJobStore) RetryAttempt(context.Context, string, int) error { return nil }
func (s *fakeJobStore) ReserveForJob(_ context.Context, jobID string, attempt int, _ string) (string, error) {
	s.quotaReserves++
	s.quotaJobID, s.quotaAttempt = jobID, attempt
	return "job-reservation", nil
}
func (s *fakeJobStore) StartForJob(_ context.Context, jobID string, attempt int, _ string) error {
	s.quotaStarts++
	s.quotaJobID, s.quotaAttempt = jobID, attempt
	return nil
}
func (s *fakeJobStore) ReleaseForJob(_ context.Context, jobID string, attempt int, _ string) error {
	s.quotaReleases++
	s.quotaJobID, s.quotaAttempt = jobID, attempt
	return nil
}
func (s *fakeJobStore) SettleForJob(_ context.Context, jobID string, attempt int, _, _, _ string) error {
	s.quotaSettles++
	s.quotaJobID, s.quotaAttempt = jobID, attempt
	return nil
}
func (*fakeJobStore) Close() {}

func TestAudioJobStatusAndResultRequireOwner(t *testing.T) {
	store := &fakeJobStore{job: audiojobs.Job{ID: "job-1", UserID: "00000000-0000-4000-8000-000000000001", State: "succeeded", Result: []byte(`{"featureTimeline":{},"musicSummary":{},"analysisMetadata":{}}`)}}
	handler, err := NewJobAPI(&Handler{}, store)
	if err != nil {
		t.Fatal(err)
	}
	e := echo.New()
	passPrincipal := func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			user := c.Request().Header.Get("X-Test-User")
			c.SetRequest(c.Request().WithContext(authn.ContextWithPrincipal(c.Request().Context(), authn.Principal{Subject: user})))
			return next(c)
		}
	}
	handler.Register(e, passPrincipal)
	call := func(path, user string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("X-Test-User", user)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec
	}
	wrong := call("/api/v1/audio/jobs/job-1", "00000000-0000-4000-8000-000000000002")
	if wrong.Code != http.StatusNotFound {
		t.Fatalf("foreign job was exposed: status=%d", wrong.Code)
	}
	correct := call("/api/v1/audio/jobs/job-1", "00000000-0000-4000-8000-000000000001")
	if correct.Code != http.StatusOK {
		t.Fatalf("owner status failed: status=%d body=%s", correct.Code, correct.Body.String())
	}
	var status jobStatus
	if err := json.Unmarshal(correct.Body.Bytes(), &status); err != nil || status.State != "succeeded" {
		t.Fatalf("unexpected job status: %#v err=%v", status, err)
	}
	result := call("/api/v1/audio/jobs/job-1/result", "00000000-0000-4000-8000-000000000001")
	if result.Code != http.StatusOK || result.Body.String() != string(store.job.Result) {
		t.Fatalf("owner result failed: status=%d body=%s", result.Code, result.Body.String())
	}
}

func TestAudioJobWorkerReusesSynchronousQuotaAndAnalysisPath(t *testing.T) {
	store := &fakeJobStore{job: audiojobs.Job{ID: "job-worker", Attempt: 1, UserID: "00000000-0000-4000-8000-000000000001", Audio: make([]byte, 100), KickGateMode: "hard"}}
	admission := &fakeAdmission{}
	analysis, err := NewHandler(Config{TempDirectory: t.TempDir(), Timeout: time.Second, Prober: fakeProber{info: validInfo()}, Runner: &fakeRunner{}, Admission: admission})
	if err != nil {
		t.Fatal(err)
	}
	api, err := NewJobAPI(analysis, store)
	if err != nil {
		t.Fatal(err)
	}
	api.runClaimed(context.Background(), store.job)
	if store.finishedState != "succeeded" || len(store.finishedResult) == 0 {
		t.Fatalf("worker did not settle successful analysis: state=%s result=%d", store.finishedState, len(store.finishedResult))
	}
	if store.quotaReserves != 1 || store.quotaStarts != 1 || store.quotaSettles != 1 || store.quotaJobID != store.job.ID || store.quotaAttempt != store.job.Attempt {
		t.Fatalf("worker quota calls were not fenced by job/attempt: reserves=%d starts=%d settles=%d job=%s attempt=%d", store.quotaReserves, store.quotaStarts, store.quotaSettles, store.quotaJobID, store.quotaAttempt)
	}
}

func TestAudioJobSubmitPersistsVerifiedOwnerWithoutChargingWaiter(t *testing.T) {
	store := &fakeJobStore{job: audiojobs.Job{ID: "job-1"}}
	admission := &fakeAdmission{}
	analysis, err := NewHandler(Config{TempDirectory: t.TempDir(), Timeout: time.Second, Prober: fakeProber{info: validInfo()}, Runner: &fakeRunner{}, Admission: admission})
	if err != nil {
		t.Fatal(err)
	}
	api, err := NewJobAPI(analysis, store)
	if err != nil {
		t.Fatal(err)
	}
	e := echo.New()
	auth := func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			c.SetRequest(c.Request().WithContext(authn.ContextWithPrincipal(c.Request().Context(), authn.Principal{Subject: "00000000-0000-4000-8000-000000000001"})))
			return next(c)
		}
	}
	api.Register(e, auth)
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("audio", "clip.wav")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(make([]byte, 100)); err != nil {
		t.Fatal(err)
	}
	if err := form.WriteField("kickGateMode", "soft"); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/audio/jobs", &body)
	req.Header.Set(echo.HeaderContentType, form.FormDataContentType())
	req.Header.Set("Idempotency-Key", "browser-request-1")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted || store.submittedUser != "00000000-0000-4000-8000-000000000001" || store.submittedKey != "browser-request-1" || store.job.KickGateMode != "soft" {
		t.Fatalf("job submit failed: status=%d user=%s key=%s gate=%s body=%s", rec.Code, store.submittedUser, store.submittedKey, store.job.KickGateMode, rec.Body.String())
	}
	if admission.reserveCalls != 0 {
		t.Fatalf("waiting job consumed execution quota: reserve calls=%d", admission.reserveCalls)
	}
}

func TestAudioJobSubmitStoresPrivateObjectBeforeRegisteringJob(t *testing.T) {
	store := &fakeStorageJobStore{fakeJobStore: &fakeJobStore{job: audiojobs.Job{ID: "job-storage"}}}
	storage := &fakeAudioStorage{}
	analysis, err := NewHandler(Config{TempDirectory: t.TempDir(), Timeout: time.Second, Prober: fakeProber{info: validInfo()}, Runner: &fakeRunner{}, Admission: &fakeAdmission{}})
	if err != nil {
		t.Fatal(err)
	}
	api, err := NewJobAPI(analysis, store)
	if err != nil {
		t.Fatal(err)
	}
	api.SetStorage(storage)
	e := echo.New()
	auth := func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			c.SetRequest(c.Request().WithContext(authn.ContextWithPrincipal(c.Request().Context(), authn.Principal{Subject: "00000000-0000-4000-8000-000000000001"})))
			return next(c)
		}
	}
	api.Register(e, auth)
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("audio", "clip.wav")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(make([]byte, 100))
	_ = form.WriteField("kickGateMode", "soft")
	_ = form.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/audio/jobs", &body)
	req.Header.Set(echo.HeaderContentType, form.FormDataContentType())
	req.Header.Set("Idempotency-Key", "storage-request")
	serverStore := &orderedStorageFake{fakeStorageJobStore: store, storage: storage}
	api.store = serverStore
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted || store.submittedUser != "00000000-0000-4000-8000-000000000001" || storage.key != store.objectKey || len(storage.data) != 100 {
		t.Fatalf("Storage-backed submission failed: status=%d key=%q body=%s", rec.Code, storage.key, rec.Body.String())
	}
}

type orderedStorageFake struct {
	*fakeStorageJobStore
	storage *fakeAudioStorage
}

func (s *orderedStorageFake) SubmitStored(ctx context.Context, user, key string, hash []byte, jobID, gate string) (string, bool, error) {
	s.fakeStorageJobStore.stored = len(s.storage.data) > 0
	return s.fakeStorageJobStore.SubmitStored(ctx, user, key, hash, jobID, gate)
}

func TestJobMultipartPreservesGateAndAudio(t *testing.T) {
	body, contentType, err := makeJobMultipart([]byte{1, 2, 3, 4}, "soft")
	if err != nil || contentType == "" || len(body) == 0 {
		t.Fatalf("multipart construction failed: type=%q err=%v", contentType, err)
	}
}
