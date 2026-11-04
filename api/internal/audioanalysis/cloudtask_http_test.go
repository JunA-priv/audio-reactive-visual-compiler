package audioanalysis

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v5"
)

type denyTaskAuth struct{}

func (denyTaskAuth) Authenticate(*http.Request) bool { return false }
func TestTaskWorkerRejectsUnauthenticatedRequest(t *testing.T) {
	api := &JobAPI{store: &fakeJobStore{}}
	e := echo.New()
	api.RegisterTaskWorker(e, denyTaskAuth{})
	req := httptest.NewRequest(http.MethodPost, "/internal/tasks/audio-analysis", strings.NewReader(`{"jobId":"x","generation":1}`))
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusUnauthorized)
	}
}
