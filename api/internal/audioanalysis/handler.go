package audioanalysis

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/audiobudget"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/authn"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/service"
	"github.com/labstack/echo/v5"
)

const (
	MaxRequestBytes = 16 << 20
	MaxClipSeconds  = 60.0
	DefaultTimeout  = 600 * time.Second
	maxTimelineJSON = 8 << 20
	maxSummaryJSON  = 1 << 20
	maxMetadataJSON = 1 << 20
	orphanTempAge   = 15 * time.Minute
)

type WAVInfo struct {
	DurationSeconds float64
	SampleRate      int
	Channels        int
	Codec           string
	Format          string
}

type Prober interface {
	Probe(context.Context, string) (WAVInfo, error)
}

type Runner interface {
	Analyze(context.Context, string, string, string) error
}

var kickGateModes = map[string]struct{}{"off": {}, "soft": {}, "middle": {}, "hard": {}}

type Config struct {
	PythonExecutable  string
	PythonDirectory   string
	FFprobeExecutable string
	TempDirectory     string
	Timeout           time.Duration
	Threads           int
	Prober            Prober
	Runner            Runner
	Logger            *slog.Logger
	Admission         audiobudget.Store
}

type Handler struct {
	timeout   time.Duration
	tempDir   string
	prober    Prober
	runner    Runner
	logger    *slog.Logger
	admission audiobudget.Store
	slots     chan struct{}
}

type response struct {
	FeatureTimeline  json.RawMessage `json:"featureTimeline"`
	MusicSummary     json.RawMessage `json:"musicSummary"`
	AnalysisMetadata json.RawMessage `json:"analysisMetadata"`
}

type commandRunner struct {
	executable string
	workDir    string
	threads    int
}

type ffprobe struct{ executable string }

func NewHandler(cfg Config) (*Handler, error) {
	if cfg.Timeout <= 0 {
		cfg.Timeout = DefaultTimeout
	}
	if cfg.Threads == 0 {
		cfg.Threads = 4
	}
	if cfg.Threads < 1 || cfg.Threads > 16 {
		return nil, errors.New("audio analysis threads must be between 1 and 16")
	}
	if cfg.Prober == nil {
		probePath := cfg.FFprobeExecutable
		if probePath == "" {
			probePath = "ffprobe"
		}
		resolved, err := exec.LookPath(probePath)
		if err != nil {
			return nil, errors.New("ffprobe executable is unavailable")
		}
		cfg.Prober = ffprobe{executable: resolved}
	}
	if cfg.Runner == nil {
		if cfg.PythonExecutable == "" || cfg.PythonDirectory == "" {
			return nil, errors.New("Python Island executable configuration is required")
		}
		executable, err := filepath.Abs(cfg.PythonExecutable)
		if err != nil {
			return nil, errors.New("Python Island executable path is invalid")
		}
		workDir, err := filepath.Abs(cfg.PythonDirectory)
		if err != nil {
			return nil, errors.New("Python Island working directory is invalid")
		}
		info, err := os.Stat(executable)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
			return nil, errors.New("Python Island executable is unavailable")
		}
		workInfo, err := os.Stat(workDir)
		if err != nil || !workInfo.IsDir() {
			return nil, errors.New("Python Island working directory is unavailable")
		}
		cfg.Runner = commandRunner{executable: executable, workDir: workDir, threads: cfg.Threads}
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if strings.TrimSpace(cfg.TempDirectory) == "" {
		cfg.TempDirectory = os.TempDir()
	}
	cleanupOrphanedAnalysisTemps(cfg.TempDirectory, time.Now())
	return &Handler{timeout: cfg.Timeout, tempDir: cfg.TempDirectory, prober: cfg.Prober, runner: cfg.Runner, logger: cfg.Logger, admission: cfg.Admission, slots: make(chan struct{}, 1)}, nil
}

// cleanupOrphanedAnalysisTemps removes only this feature's old private temp
// directories. The age threshold exceeds the 10-minute analysis deadline plus
// cancellation grace, so another live API process will not lose active work.
func cleanupOrphanedAnalysisTemps(root string, now time.Time) int {
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0
	}
	removed := 0
	cutoff := now.Add(-orphanTempAge)
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "arvc-audio-analysis-") && !strings.HasPrefix(entry.Name(), "arvc-audio-job-upload-") {
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.IsDir() || !info.ModTime().Before(cutoff) {
			continue
		}
		if os.RemoveAll(filepath.Join(root, entry.Name())) == nil {
			removed++
		}
	}
	return removed
}

func (h *Handler) Register(e *echo.Echo, authMiddleware func(echo.HandlerFunc) echo.HandlerFunc) {
	guarded := authMiddleware(h.analyze)
	e.POST("/api/v1/audio/analyze", func(c *echo.Context) error {
		r := c.Request()
		started := time.Now()
		originalWriter := c.Response()
		statusWriter := &requestStatusWriter{ResponseWriter: originalWriter}
		c.SetResponse(statusWriter)
		defer c.SetResponse(originalWriter)
		h.logger.InfoContext(r.Context(), "audio analysis HTTP request received", "content_length", r.ContentLength)
		err := guarded(c)
		status := statusWriter.status
		if status == 0 {
			status = http.StatusOK
		}
		attrs := []any{"content_length", r.ContentLength, "status", status, "elapsed_ms", time.Since(started).Milliseconds()}
		if errors.Is(r.Context().Err(), context.Canceled) {
			attrs = append(attrs, "canceled", true)
		}
		if status >= http.StatusInternalServerError {
			h.logger.WarnContext(r.Context(), "audio analysis HTTP request finished", attrs...)
		} else {
			h.logger.InfoContext(r.Context(), "audio analysis HTTP request finished", attrs...)
		}
		return err
	})
}

type requestStatusWriter struct {
	http.ResponseWriter
	status int
}

func (w *requestStatusWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *requestStatusWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(body)
}

func (w *requestStatusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (h *Handler) analyze(c *echo.Context) error {
	return h.analyzeWithAdmission(c, h.admission)
}

func (h *Handler) analyzeWithAdmission(c *echo.Context, admission audiobudget.Store) error {
	r := c.Request()
	principal, authenticated := authn.PrincipalFrom(r.Context())
	if !authenticated {
		return writeError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	if admission == nil {
		return writeError(c, http.StatusServiceUnavailable, "analysis_control_unavailable", "audio analysis is temporarily unavailable")
	}
	reservation, err := admission.Reserve(r.Context(), principal.Subject)
	if err != nil {
		if errors.Is(err, audiobudget.ErrNotEntitled) {
			drainRejectedEntitlementBody(c)
		}
		return admissionError(c, err)
	}
	started := false
	settled := false
	defer func() {
		if started && !settled {
			h.settleDetached(admission, reservation.ID, audiobudget.StateFailed, "handler_aborted")
		}
		if !started {
			releaseCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := admission.Release(releaseCtx, reservation.ID); err != nil {
				h.logger.WarnContext(r.Context(), "audio analysis reservation release failed", "classification", "admission_release_failed")
			}
		}
	}()
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	default:
		h.logger.InfoContext(r.Context(), "audio analysis request rejected", "classification", "analysis_busy", "content_length", r.ContentLength)
		return writeError(c, http.StatusTooManyRequests, "analysis_busy", "another audio analysis is in progress")
	}
	mediaType, params, err := mime.ParseMediaType(c.Request().Header.Get(echo.HeaderContentType))
	if err != nil || mediaType != "multipart/form-data" || params["boundary"] == "" {
		h.logger.WarnContext(r.Context(), "audio analysis request rejected", "classification", "invalid_content_type", "content_length", r.ContentLength)
		return writeError(c, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be multipart/form-data")
	}
	r.Body = http.MaxBytesReader(c.Response(), r.Body, MaxRequestBytes)
	ctx, cancel := context.WithTimeout(r.Context(), h.timeout)
	defer cancel()
	r = r.WithContext(ctx)
	c.SetRequest(r)
	workDir, err := os.MkdirTemp(h.tempDir, "arvc-audio-analysis-")
	if err != nil {
		return writeError(c, http.StatusInternalServerError, "analysis_unavailable", "audio analysis could not start")
	}
	defer func() { _ = os.RemoveAll(workDir) }()
	if err := os.Chmod(workDir, 0700); err != nil {
		return writeError(c, http.StatusInternalServerError, "analysis_unavailable", "audio analysis could not start")
	}
	inputPath := filepath.Join(workDir, "clip.wav")
	inputBytes, kickGateMode, err := receiveAnalysisRequest(c, inputPath)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			h.logger.WarnContext(r.Context(), "audio analysis request rejected", "classification", "request_too_large", "stage", "receive_audio", "content_length", r.ContentLength)
			return writeError(c, http.StatusRequestEntityTooLarge, "request_too_large", "request exceeds 16 MiB")
		}
		if errors.Is(r.Context().Err(), context.Canceled) || errors.Is(err, context.Canceled) {
			h.logger.InfoContext(r.Context(), "audio analysis request canceled", "stage", "receive_audio", "content_length", r.ContentLength)
			return nil
		}
		h.logger.WarnContext(r.Context(), "audio analysis request rejected", "classification", "invalid_audio_upload", "stage", "receive_audio", "content_length", r.ContentLength)
		return writeError(c, http.StatusUnprocessableEntity, "invalid_audio", "request must contain exactly one WAV audio clip")
	}
	info, err := h.prober.Probe(ctx, inputPath)
	if err != nil || !validWAV(info) {
		h.logger.WarnContext(r.Context(), "audio analysis request rejected", "classification", "invalid_audio", "stage", "probe", "content_length", r.ContentLength, "audio_bytes", inputBytes)
		return writeError(c, http.StatusUnprocessableEntity, "invalid_audio", "audio must be 44.1 kHz stereo PCM16 WAV and no longer than 60 seconds")
	}
	outputDir := filepath.Join(workDir, "output")
	if err := os.Mkdir(outputDir, 0700); err != nil {
		return writeError(c, http.StatusInternalServerError, "analysis_unavailable", "audio analysis could not start")
	}
	if err := admission.Start(ctx, reservation.ID); err != nil {
		return admissionError(c, err)
	}
	started = true
	settle := func(state, safeCode string) error {
		if err := h.settleDetached(admission, reservation.ID, state, safeCode); err != nil {
			return writeError(c, http.StatusServiceUnavailable, "analysis_control_unavailable", "audio analysis is temporarily unavailable")
		}
		settled = true
		return nil
	}
	analysisStarted := time.Now()
	if err := h.runner.Analyze(ctx, inputPath, outputDir, kickGateMode); err != nil {
		elapsed := time.Since(analysisStarted).Milliseconds()
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			if settleErr := settle(audiobudget.StateFailed, "timeout"); settleErr != nil {
				return settleErr
			}
			h.logger.WarnContext(r.Context(), "audio analysis failed", "classification", "timeout", "elapsed_ms", elapsed)
			return writeError(c, http.StatusGatewayTimeout, "analysis_timeout", "audio analysis timed out")
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			if settleErr := settle(audiobudget.StateCanceled, "canceled"); settleErr != nil {
				return settleErr
			}
			h.logger.InfoContext(r.Context(), "audio analysis canceled", "elapsed_ms", elapsed)
			return writeError(c, 499, "analysis_canceled", "audio analysis was canceled")
		}
		if settleErr := settle(audiobudget.StateFailed, "analysis_failed"); settleErr != nil {
			return settleErr
		}
		attrs := []any{"classification", "python_process_error", "stage", "python", "elapsed_ms", elapsed, "audio_bytes", inputBytes}
		attrs = append(attrs, pythonProcessDetails(err)...)
		h.logger.WarnContext(r.Context(), "audio analysis failed", attrs...)
		return writeError(c, http.StatusBadGateway, "analysis_failed", "audio analysis failed")
	}
	result, err := readAndValidateResult(outputDir, info.DurationSeconds, inputBytes)
	if err != nil {
		if settleErr := settle(audiobudget.StateFailed, "invalid_output"); settleErr != nil {
			return settleErr
		}
		h.logger.WarnContext(r.Context(), "audio analysis output rejected", "classification", "invalid_analysis_output", "elapsed_ms", time.Since(analysisStarted).Milliseconds())
		return writeError(c, http.StatusBadGateway, "invalid_analysis_output", "audio analysis returned invalid data")
	}
	if settleErr := settle(audiobudget.StateSucceeded, ""); settleErr != nil {
		return settleErr
	}
	h.logger.InfoContext(r.Context(), "audio analysis completed", "elapsed_ms", time.Since(analysisStarted).Milliseconds(), "duration_ms", int64(result.durationMs), "timeline_points", result.timelinePoints, "kick_events", result.kickEvents)
	return c.JSON(http.StatusOK, result.response)
}

// drainRejectedEntitlementBody lets a streaming reverse proxy finish writing a
// bounded authenticated request before the early 403 closes the HTTP/1
// connection. Unauthenticated requests never reach this handler, and the
// byte limit keeps rejection from becoming an unbounded body read.
func drainRejectedEntitlementBody(c *echo.Context) {
	r := c.Request()
	if r.ContentLength > MaxRequestBytes {
		return
	}
	r.Body = http.MaxBytesReader(c.Response(), r.Body, MaxRequestBytes)
	_, _ = io.Copy(io.Discard, r.Body)
}

func admissionError(c *echo.Context, err error) error {
	switch {
	case errors.Is(err, audiobudget.ErrNotEntitled):
		return writeError(c, http.StatusForbidden, "analysis_not_entitled", "audio analysis is not enabled for this account")
	case errors.Is(err, audiobudget.ErrQuotaExceeded):
		return writeError(c, http.StatusTooManyRequests, "analysis_quota_exceeded", "audio analysis quota has been reached")
	case errors.Is(err, audiobudget.ErrConcurrency):
		return writeError(c, http.StatusTooManyRequests, "analysis_busy", "audio analysis capacity is busy")
	case errors.Is(err, audiobudget.ErrRateLimited):
		return writeError(c, http.StatusTooManyRequests, "analysis_rate_limited", "please wait before starting another audio analysis")
	case errors.Is(err, audiobudget.ErrExpired):
		return writeError(c, http.StatusTooManyRequests, "analysis_reservation_expired", "audio analysis request expired before it started")
	default:
		return writeError(c, http.StatusServiceUnavailable, "analysis_control_unavailable", "audio analysis is temporarily unavailable")
	}
}

func (h *Handler) settleDetached(admission audiobudget.Store, id, state, safeCode string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return admission.Settle(ctx, id, state, safeCode)
}

func pythonProcessDetails(err error) []any {
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return nil
	}
	attrs := []any{"python_exit_code", exitErr.ExitCode()}
	if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		attrs = append(attrs, "python_signal", status.Signal().String())
	}
	return attrs
}

func receiveAnalysisRequest(c *echo.Context, path string) (int64, string, error) {
	r := c.Request()
	mr, err := r.MultipartReader()
	if err != nil {
		return 0, "", err
	}
	var inputBytes int64
	gateMode := "hard"
	seenAudio, seenGateMode := false, false
	for {
		part, nextErr := mr.NextPart()
		if nextErr == io.EOF {
			break
		}
		if nextErr != nil {
			return 0, "", nextErr
		}
		switch part.FormName() {
		case "audio":
			if seenAudio || part.FileName() == "" {
				_ = part.Close()
				return 0, "", errors.New("missing or duplicate audio part")
			}
			seenAudio = true
			partType, _, _ := mime.ParseMediaType(part.Header.Get(echo.HeaderContentType))
			if partType != "audio/wav" && partType != "audio/x-wav" && partType != "application/octet-stream" {
				_ = part.Close()
				return 0, "", errors.New("invalid audio part type")
			}
			f, openErr := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if openErr != nil {
				_ = part.Close()
				return 0, "", openErr
			}
			inputBytes, err = io.Copy(f, io.LimitReader(part, MaxRequestBytes+1))
			closeErr := f.Close()
			partErr := part.Close()
			if err != nil {
				return 0, "", err
			}
			if closeErr != nil {
				return 0, "", closeErr
			}
			if partErr != nil {
				return 0, "", partErr
			}
			if inputBytes <= 44 || inputBytes > MaxRequestBytes {
				return 0, "", errors.New("WAV size is invalid")
			}
		case "kickGateMode":
			if seenGateMode || part.FileName() != "" {
				_ = part.Close()
				return 0, "", errors.New("invalid or duplicate kick gate mode")
			}
			seenGateMode = true
			value, readErr := io.ReadAll(io.LimitReader(part, 33))
			partErr := part.Close()
			if readErr != nil {
				return 0, "", readErr
			}
			if partErr != nil || len(value) > 32 {
				return 0, "", errors.New("invalid kick gate mode")
			}
			gateMode = string(value)
			if _, ok := kickGateModes[gateMode]; !ok {
				return 0, "", errors.New("invalid kick gate mode")
			}
		default:
			_ = part.Close()
			return 0, "", errors.New("unexpected multipart field")
		}
	}
	if !seenAudio {
		return 0, "", errors.New("missing audio part")
	}
	return inputBytes, gateMode, nil
}

func validWAV(info WAVInfo) bool {
	return info.Format == "wav" && info.Codec == "pcm_s16le" && info.SampleRate == 44100 && info.Channels == 2 && !math.IsNaN(info.DurationSeconds) && !math.IsInf(info.DurationSeconds, 0) && info.DurationSeconds > 0 && info.DurationSeconds <= MaxClipSeconds
}

type probeOutput struct {
	Streams []struct {
		CodecName  string `json:"codec_name"`
		SampleRate string `json:"sample_rate"`
		Channels   int    `json:"channels"`
		Duration   string `json:"duration"`
	} `json:"streams"`
	Format struct {
		FormatName string `json:"format_name"`
		Duration   string `json:"duration"`
	} `json:"format"`
}

func (p ffprobe) Probe(parent context.Context, path string) (WAVInfo, error) {
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, p.executable, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels,duration:format=duration,format_name", "-of", "json", path)
	var output bytes.Buffer
	cmd.Stdout = &output
	if err := runInProcessGroup(ctx, cmd); err != nil {
		return WAVInfo{}, errors.New("ffprobe rejected WAV")
	}
	var parsed probeOutput
	if json.Unmarshal(output.Bytes(), &parsed) != nil || len(parsed.Streams) != 1 || !strings.Contains(strings.Split(parsed.Format.FormatName, ",")[0], "wav") {
		return WAVInfo{}, errors.New("invalid WAV metadata")
	}
	s := parsed.Streams[0]
	durationRaw := s.Duration
	if durationRaw == "" {
		durationRaw = parsed.Format.Duration
	}
	duration, err := strconv.ParseFloat(durationRaw, 64)
	rate, rateErr := strconv.Atoi(s.SampleRate)
	if err != nil || rateErr != nil {
		return WAVInfo{}, errors.New("invalid WAV metadata")
	}
	return WAVInfo{DurationSeconds: duration, SampleRate: rate, Channels: s.Channels, Codec: s.CodecName, Format: "wav"}, nil
}

func (r commandRunner) Analyze(parent context.Context, inputPath, outputDir, gateMode string) error {
	cmd := exec.CommandContext(parent, r.executable, pythonIslandArgs(inputPath, outputDir, gateMode, r.threads)...)
	cmd.Dir = r.workDir
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	return runInProcessGroup(parent, cmd)
}

func pythonIslandArgs(inputPath, outputDir, gateMode string, threads int) []string {
	return []string{inputPath, "--output-dir", outputDir, "--threads", strconv.Itoa(threads), "--kick-gate-mode", gateMode}
}

const processGroupTerminationGrace = 500 * time.Millisecond

func runInProcessGroup(ctx context.Context, cmd *exec.Cmd) error {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var timerMu sync.Mutex
	var killTimer *time.Timer
	var killDone chan struct{}
	finished := false
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		pid := cmd.Process.Pid
		timerMu.Lock()
		defer timerMu.Unlock()
		if finished {
			return os.ErrProcessDone
		}
		err := syscall.Kill(-pid, syscall.SIGTERM)
		if err != nil && !errors.Is(err, syscall.ESRCH) {
			return err
		}
		if killTimer == nil {
			killDone = make(chan struct{})
			killTimer = time.AfterFunc(processGroupTerminationGrace, func() {
				_ = killProcessGroup(pid)
				close(killDone)
			})
		}
		return nil
	}
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	timerMu.Lock()
	finished = true
	timer := killTimer
	done := killDone
	ctxErr := ctx.Err()
	if ctxErr != nil && timer == nil {
		_ = killProcessGroup(processPID(cmd))
	}
	timerMu.Unlock()
	if ctxErr == nil {
		return err
	}

	// Wait until the entire group is killed before the caller's deferred temp-dir
	// cleanup runs. cmd.Run has already waited/reaped the direct child.
	if done != nil {
		<-done
	}
	return ctxErr
}

func processPID(cmd *exec.Cmd) int {
	if cmd.Process == nil {
		return 0
	}
	return cmd.Process.Pid
}

func killProcessGroup(pid int) error {
	if pid <= 0 {
		return nil
	}
	err := syscall.Kill(-pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

type validatedResult struct {
	response       response
	durationMs     float64
	timelinePoints int
	kickEvents     int
}

func readAndValidateResult(outputDir string, inputDurationSeconds float64, inputBytes int64) (validatedResult, error) {
	var result validatedResult
	if err := readJSON(filepath.Join(outputDir, "feature-timeline.json"), maxTimelineJSON, &result.response.FeatureTimeline); err != nil {
		return result, err
	}
	if err := readJSON(filepath.Join(outputDir, "music-summary.json"), maxSummaryJSON, &result.response.MusicSummary); err != nil {
		return result, err
	}
	if err := readJSON(filepath.Join(outputDir, "analysis-metadata.json"), maxMetadataJSON, &result.response.AnalysisMetadata); err != nil {
		return result, err
	}
	summaryValue, timeline, _, err := service.ValidateInput(service.Request{MusicSummary: result.response.MusicSummary, FeatureTimeline: result.response.FeatureTimeline})
	if err != nil {
		return result, err
	}
	var timelineMeta struct {
		AnalysisVersion string `json:"analysisVersion"`
		SampleRateHz    int    `json:"sampleRateHz"`
	}
	var summary struct {
		DurationMs int64 `json:"durationMs"`
	}
	var metadata struct {
		MetadataVersion int `json:"metadataVersion"`
	}
	if json.Unmarshal(result.response.FeatureTimeline, &timelineMeta) != nil || timelineMeta.AnalysisVersion == "" || timelineMeta.SampleRateHz != 44_100 {
		return result, errors.New("invalid Feature Timeline metadata")
	}
	if json.Unmarshal(result.response.MusicSummary, &summary) != nil || json.Unmarshal(result.response.AnalysisMetadata, &metadata) != nil || metadata.MetadataVersion != 1 {
		return result, errors.New("invalid analysis metadata")
	}
	if (summaryValue.Analysis.Model != "scnet_standard" && summaryValue.Analysis.Model != "htdemucs") || summaryValue.Analysis.Device != "cpu" || summaryValue.SourceAudio.Format != "wav" || summaryValue.SourceAudio.Codec != "pcm_s16le" || summaryValue.SourceAudio.SampleRateHz != 44_100 || summaryValue.SourceAudio.Channels != 2 || summaryValue.SourceAudio.FileBytes != inputBytes {
		return result, errors.New("unexpected analysis model or audio format")
	}
	inputDurationMs := inputDurationSeconds * 1000
	if summary.DurationMs < 1 || summary.DurationMs > 60_000 || mathAbs(float64(summary.DurationMs)-inputDurationMs) > 1.1 || float64(timeline.DurationMs) != float64(summary.DurationMs) {
		return result, errors.New("analysis duration does not match clip")
	}
	result.durationMs = float64(timeline.DurationMs)
	result.timelinePoints = len(timeline.BassEnvelope)
	result.kickEvents = len(timeline.KickEvents)
	return result, nil
}

func readJSON(path string, limit int64, target *json.RawMessage) error {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 2 || info.Size() > limit {
		return errors.New("analysis output file is unavailable")
	}
	data, err := os.ReadFile(path)
	if err != nil || !json.Valid(data) {
		return errors.New("analysis output is invalid JSON")
	}
	*target = json.RawMessage(data)
	return nil
}

func mathAbs(value float64) float64 {
	if value < 0 {
		return -value
	}
	return value
}

func writeError(c *echo.Context, status int, code, message string) error {
	return c.JSON(status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
