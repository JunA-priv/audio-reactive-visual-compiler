package audioanalysis

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/audiobudget"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/audiojobs"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/authn"
	"github.com/labstack/echo/v5"
)

type JobAPI struct {
	analysis   *Handler
	store      audiojobs.Store
	dispatcher interface{ Dispatch(context.Context) error }
}

func (j *JobAPI) SetDispatcher(d interface{ Dispatch(context.Context) error }) { j.dispatcher = d }

type jobQuota interface {
	ReserveForJob(context.Context, string, int, string) (string, error)
	StartForJob(context.Context, string, int, string) error
	ReleaseForJob(context.Context, string, int, string) error
	SettleForJob(context.Context, string, int, string, string, string) error
}

type attemptAdmission struct {
	quota jobQuota
	job   audiojobs.Job
}

func (a attemptAdmission) Reserve(ctx context.Context, userID string) (audiobudget.Reservation, error) {
	id, err := a.quota.ReserveForJob(ctx, a.job.ID, a.job.Attempt, userID)
	return audiobudget.Reservation{ID: id}, err
}
func (a attemptAdmission) Start(ctx context.Context, id string) error {
	return a.quota.StartForJob(ctx, a.job.ID, a.job.Attempt, id)
}
func (a attemptAdmission) Release(ctx context.Context, id string) error {
	return a.quota.ReleaseForJob(ctx, a.job.ID, a.job.Attempt, id)
}
func (a attemptAdmission) Settle(ctx context.Context, id, state, code string) error {
	return a.quota.SettleForJob(ctx, a.job.ID, a.job.Attempt, id, state, code)
}
func (attemptAdmission) Close() {}

type jobStatus struct {
	JobID           string `json:"jobId"`
	State           string `json:"state"`
	QueuePosition   int64  `json:"queuePosition,omitempty"`
	ErrorCode       string `json:"errorCode,omitempty"`
	CancelRequested bool   `json:"cancelRequested,omitempty"`
}

func NewJobAPI(analysis *Handler, store audiojobs.Store) (*JobAPI, error) {
	if analysis == nil || store == nil {
		return nil, errors.New("audio job configuration is incomplete")
	}
	return &JobAPI{analysis: analysis, store: store}, nil
}

func (j *JobAPI) Register(e *echo.Echo, authMiddleware func(echo.HandlerFunc) echo.HandlerFunc) {
	e.POST("/api/v1/audio/jobs", authMiddleware(j.submit))
	e.GET("/api/v1/audio/jobs/:jobID", authMiddleware(j.get))
	e.GET("/api/v1/audio/jobs/:jobID/result", authMiddleware(j.result))
	e.DELETE("/api/v1/audio/jobs/:jobID", authMiddleware(j.cancel))
}

func (j *JobAPI) submit(c *echo.Context) error {
	principal, ok := authn.PrincipalFrom(c.Request().Context())
	if !ok {
		return writeError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	key := strings.TrimSpace(c.Request().Header.Get("Idempotency-Key"))
	if len(key) < 1 || len(key) > 128 {
		return writeError(c, http.StatusBadRequest, "invalid_idempotency_key", "a valid Idempotency-Key is required")
	}
	r := c.Request()
	r.Body = http.MaxBytesReader(c.Response(), r.Body, MaxRequestBytes)
	dir, err := os.MkdirTemp(j.analysis.tempDir, "arvc-audio-job-upload-")
	if err != nil {
		return writeError(c, http.StatusInternalServerError, "analysis_unavailable", "audio analysis could not start")
	}
	defer os.RemoveAll(dir)
	inputPath := filepath.Join(dir, "clip.wav")
	inputBytes, gate, err := receiveAnalysisRequest(c, inputPath)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return writeError(c, http.StatusRequestEntityTooLarge, "request_too_large", "request exceeds 16 MiB")
		}
		if errors.Is(r.Context().Err(), context.Canceled) {
			return nil
		}
		return writeError(c, http.StatusUnprocessableEntity, "invalid_audio", "request must contain exactly one WAV audio clip")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	info, err := j.analysis.prober.Probe(ctx, inputPath)
	if err != nil || !validWAV(info) {
		return writeError(c, http.StatusUnprocessableEntity, "invalid_audio", "audio must be 44.1 kHz stereo PCM16 WAV and no longer than 60 seconds")
	}
	audio, err := os.ReadFile(inputPath)
	if err != nil || int64(len(audio)) != inputBytes {
		return writeError(c, http.StatusInternalServerError, "analysis_unavailable", "audio analysis could not start")
	}
	id, existing, err := j.store.Submit(ctx, principal.Subject, key, audiojobs.HashPayload(audio, gate), audio, gate)
	if err != nil {
		return jobAdmissionError(c, err)
	}
	status := http.StatusAccepted
	if existing {
		status = http.StatusOK
	}
	if j.dispatcher != nil {
		dispatchCtx, stop := context.WithTimeout(context.Background(), 8*time.Second)
		_ = j.dispatcher.Dispatch(dispatchCtx)
		stop()
	}
	c.Response().Header().Set(echo.HeaderLocation, "/api/v1/audio/jobs/"+id)
	return c.JSON(status, jobStatus{JobID: id, State: "queued"})
}

func (j *JobAPI) get(c *echo.Context) error {
	job, err := j.ownerJob(c)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, jobStatus{JobID: job.ID, State: job.State, QueuePosition: job.QueuePosition, ErrorCode: job.SafeError, CancelRequested: job.CancelRequested})
}

func (j *JobAPI) result(c *echo.Context) error {
	job, err := j.ownerJob(c)
	if err != nil {
		return err
	}
	if job.State != "succeeded" {
		return writeError(c, http.StatusConflict, "result_not_ready", "analysis result is not available")
	}
	p, _ := authn.PrincipalFrom(c.Request().Context())
	result, fetchErr := j.store.GetResult(c.Request().Context(), job.ID, p.Subject)
	if fetchErr != nil {
		return jobStoreError(c, fetchErr)
	}
	c.Response().Header().Set(echo.HeaderContentType, echo.MIMEApplicationJSONCharsetUTF8)
	return c.Blob(http.StatusOK, echo.MIMEApplicationJSONCharsetUTF8, result)
}

func (j *JobAPI) cancel(c *echo.Context) error {
	p, ok := authn.PrincipalFrom(c.Request().Context())
	if !ok {
		return writeError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	state, err := j.store.Cancel(c.Request().Context(), c.Param("jobID"), p.Subject)
	if err != nil {
		return jobStoreError(c, err)
	}
	switch state {
	case "not_found":
		return writeError(c, http.StatusNotFound, "job_not_found", "analysis job was not found")
	case "canceled", "cancel_requested", "terminal":
		job, getErr := j.store.GetStatus(c.Request().Context(), c.Param("jobID"), p.Subject)
		if getErr != nil {
			return jobStoreError(c, getErr)
		}
		return c.JSON(http.StatusOK, jobStatus{JobID: job.ID, State: job.State, QueuePosition: job.QueuePosition, ErrorCode: job.SafeError, CancelRequested: job.CancelRequested})
	default:
		return writeError(c, http.StatusServiceUnavailable, "analysis_control_unavailable", "audio analysis is temporarily unavailable")
	}
}

func (j *JobAPI) ownerJob(c *echo.Context) (audiojobs.Job, error) {
	p, ok := authn.PrincipalFrom(c.Request().Context())
	if !ok {
		return audiojobs.Job{}, writeError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	job, err := j.store.GetStatus(c.Request().Context(), c.Param("jobID"), p.Subject)
	if err != nil {
		return audiojobs.Job{}, jobStoreError(c, err)
	}
	return job, nil
}

func jobStoreError(c *echo.Context, err error) error {
	if errors.Is(err, audiojobs.ErrNotFound) {
		return writeError(c, http.StatusNotFound, "job_not_found", "analysis job was not found")
	}
	return writeError(c, http.StatusServiceUnavailable, "analysis_control_unavailable", "audio analysis is temporarily unavailable")
}

func jobAdmissionError(c *echo.Context, err error) error {
	switch err.Error() {
	case "disabled":
		return writeError(c, http.StatusServiceUnavailable, "analysis_disabled", "audio analysis is temporarily unavailable")
	case "not_entitled":
		return writeError(c, http.StatusForbidden, "analysis_not_entitled", "audio analysis is not enabled for this account")
	case "queue_full", "user_queue_full":
		return writeError(c, http.StatusTooManyRequests, "analysis_queue_full", "audio analysis queue is full; retry later")
	case "idempotency_conflict":
		return writeError(c, http.StatusConflict, "idempotency_conflict", "Idempotency-Key was already used for a different request")
	case "invalid":
		return writeError(c, http.StatusBadRequest, "invalid_audio_job", "audio job request is invalid")
	default:
		return writeError(c, http.StatusServiceUnavailable, "analysis_control_unavailable", "audio analysis is temporarily unavailable")
	}
}

// RunQueue polls the durable DB claim function. Each API/worker process runs a
// single loop; the DB claim transaction caps aggregate work at two jobs.
func (j *JobAPI) RunQueue(ctx context.Context) {
	for ctx.Err() == nil {
		job, claimed, err := j.store.Claim(ctx)
		if err != nil {
			sleepContext(ctx, 2*time.Second)
			continue
		}
		if !claimed {
			sleepContext(ctx, 750*time.Millisecond)
			continue
		}
		j.runClaimed(ctx, job)
	}
}

func (j *JobAPI) runClaimed(parent context.Context, job audiojobs.Job) bool {
	quota, ok := j.store.(jobQuota)
	if !ok || job.Attempt < 1 {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		_ = j.store.FinishAttempt(ctx, job.ID, job.Attempt, "failed", nil, "job_configuration")
		stop()
		return false
	}
	jobAdmission := attemptAdmission{quota: quota, job: job}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	finished := make(chan struct{})
	userCancel := make(chan struct{})
	go func() {
		defer close(finished)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				requested, err := j.store.CancelRequested(ctx, job.ID, job.UserID)
				if err == nil && requested {
					close(userCancel)
					cancel()
					return
				}
			}
		}
	}()
	body, contentType, err := makeJobMultipart(job.Audio, job.KickGateMode)
	var result []byte
	state, code := "failed", "analysis_failed"
	if err == nil {
		req, _ := http.NewRequestWithContext(authn.ContextWithPrincipal(ctx, authn.Principal{Subject: job.UserID}), http.MethodPost, "/api/v1/audio/analyze", bytes.NewReader(body))
		req.Header.Set(echo.HeaderContentType, contentType)
		recorder := httptest.NewRecorder()
		ec := echo.New().NewContext(req, recorder)
		_ = j.analysis.analyzeWithAdmission(ec, jobAdmission)
		if recorder.Code == http.StatusOK {
			state, code = "succeeded", ""
			result = recorder.Body.Bytes()
		} else if isClosed(userCancel) || recorder.Code == 499 {
			state, code = "canceled", "canceled"
		} else if parent.Err() != nil {
			retryCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
			_ = j.store.RetryAttempt(retryCtx, job.ID, job.Attempt)
			stop()
			cancel()
			<-finished
			return false
		} else {
			var payload struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if json.Unmarshal(recorder.Body.Bytes(), &payload) == nil && (payload.Error.Code == "analysis_busy" || payload.Error.Code == "analysis_control_unavailable") {
				retryCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
				_ = j.store.RetryAttempt(retryCtx, job.ID, job.Attempt)
				stop()
				cancel()
				<-finished
				return false
			}
		}
	}
	cancel()
	<-finished
	finishCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if err := j.store.FinishAttempt(finishCtx, job.ID, job.Attempt, state, result, code); err != nil {
		return false
	}
	return true
}

func isClosed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func makeJobMultipart(audio []byte, gate string) ([]byte, string, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("audio", "clip.wav")
	if err != nil {
		return nil, "", err
	}
	if _, err = io.Copy(part, bytes.NewReader(audio)); err != nil {
		return nil, "", err
	}
	if err = writer.WriteField("kickGateMode", gate); err != nil {
		return nil, "", err
	}
	if err = writer.Close(); err != nil {
		return nil, "", err
	}
	return body.Bytes(), writer.FormDataContentType(), nil
}

func sleepContext(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
