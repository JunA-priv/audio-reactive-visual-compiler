package audioanalysis

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v5"
)

type denyTaskAuth struct{}
type allowTaskAuth struct{}
type testPinger struct {
	err   error
	calls int
}

func (denyTaskAuth) Authenticate(*http.Request) bool  { return false }
func (allowTaskAuth) Authenticate(*http.Request) bool { return true }
func (p *testPinger) Ping(context.Context) error      { p.calls++; return p.err }

func TestDatabaseHealthCheckIsAuthenticatedReadOnlyAndGeneric(t *testing.T) {
	for _, tc := range []struct {
		name    string
		auth    TaskAuthenticator
		pingErr error
		want    int
	}{
		{"unauthenticated", denyTaskAuth{}, nil, http.StatusUnauthorized},
		{"healthy", allowTaskAuth{}, nil, http.StatusNoContent},
		{"database unavailable", allowTaskAuth{}, errors.New("secret-bearing database detail"), http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := echo.New()
			p := &testPinger{err: tc.pingErr}
			(&JobAPI{}).RegisterDatabaseHealthCheck(e, tc.auth, p)
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/internal/ops/supabase-health", nil))
			if rec.Code != tc.want {
				t.Fatalf("status=%d want=%d", rec.Code, tc.want)
			}
			if strings.Contains(rec.Body.String(), "secret-bearing") {
				t.Fatal("database details leaked")
			}
			if (tc.want == http.StatusUnauthorized && p.calls != 0) || (tc.want != http.StatusUnauthorized && p.calls != 1) {
				t.Fatalf("ping calls=%d", p.calls)
			}
		})
	}
}

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
