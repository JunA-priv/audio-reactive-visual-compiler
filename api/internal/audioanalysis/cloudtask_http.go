package audioanalysis

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/audiojobs"
	"github.com/labstack/echo/v5"
)

type TaskAuthenticator interface{ Authenticate(*http.Request) bool }
type taskRequest struct {
	JobID      string `json:"jobId"`
	Generation int    `json:"generation"`
}

// RegisterTaskWorker installs the private Cloud Tasks endpoint. The platform IAM
// invoker policy is required in addition to application-level OIDC validation.
func (j *JobAPI) RegisterTaskWorker(e *echo.Echo, auth TaskAuthenticator) {
	e.POST("/internal/tasks/audio-analysis", func(c *echo.Context) error {
		if auth == nil || !auth.Authenticate(c.Request()) {
			return c.NoContent(http.StatusUnauthorized)
		}
		c.Request().Body = http.MaxBytesReader(c.Response(), c.Request().Body, 1024)
		var r taskRequest
		dec := json.NewDecoder(c.Request().Body)
		dec.DisallowUnknownFields()
		if dec.Decode(&r) != nil || r.JobID == "" || r.Generation < 1 {
			return c.NoContent(http.StatusBadRequest)
		}
		var extra any
		if dec.Decode(&extra) != io.EOF {
			return c.NoContent(http.StatusBadRequest)
		}
		ds, ok := j.store.(audiojobs.DispatchStore)
		if !ok {
			return c.NoContent(http.StatusServiceUnavailable)
		}
		ctx, stop := context.WithTimeout(c.Request().Context(), 12*time.Minute)
		defer stop()
		result, job, err := ds.ClaimTask(ctx, audiojobs.DispatchItem{JobID: r.JobID, Generation: r.Generation})
		if err != nil {
			return c.NoContent(http.StatusServiceUnavailable)
		}
		switch result {
		case "stale", "terminal", "deferred":
			return c.NoContent(http.StatusNoContent)
		case "busy":
			c.Response().Header().Set("Retry-After", "10")
			return c.NoContent(http.StatusServiceUnavailable)
		case "claimed":
		default:
			return c.NoContent(http.StatusServiceUnavailable)
		}
		if !j.runClaimed(ctx, job) {
			c.Response().Header().Set("Retry-After", "10")
			return c.NoContent(http.StatusServiceUnavailable)
		}
		_ = ds.MarkDispatchDone(context.Background(), audiojobs.DispatchItem{JobID: r.JobID, Generation: r.Generation})
		if j.dispatcher != nil {
			dctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			_ = j.dispatcher.Dispatch(dctx)
			cancel()
		}
		return c.NoContent(http.StatusNoContent)
	})
}

// RegisterDispatchWake is invoked by Cloud Scheduler (or a local trigger) to
// recover transactional outbox rows when the API was unavailable at submit.
func (j *JobAPI) RegisterDispatchWake(e *echo.Echo, auth TaskAuthenticator) {
	e.POST("/internal/jobs/dispatch", func(c *echo.Context) error {
		if auth == nil || !auth.Authenticate(c.Request()) {
			return c.NoContent(http.StatusUnauthorized)
		}
		if j.dispatcher == nil {
			return c.NoContent(http.StatusServiceUnavailable)
		}
		ctx, cancel := context.WithTimeout(c.Request().Context(), 10*time.Second)
		defer cancel()
		dispatchErr := j.dispatcher.Dispatch(ctx)
		cleanupErr := j.CleanupStorage(ctx, 50)
		if dispatchErr != nil || cleanupErr != nil {
			return c.NoContent(http.StatusServiceUnavailable)
		}
		return c.NoContent(http.StatusNoContent)
	})
}
