package audioanalysis

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/audiojobs"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/authn"
	"github.com/jackc/pgx/v5"
	"github.com/labstack/echo/v5"
)

type storageIntegrationRunner struct {
	fileBytes int
}

func (r storageIntegrationRunner) Analyze(_ context.Context, _ string, output, _ string) error {
	timeline := strings.Replace(validTimeline, `"durationMs":1000`, `"durationMs":2000`, 1)
	summary := strings.Replace(validSummary, `"durationMs":1000`, `"durationMs":2000`, 1)
	summary = strings.Replace(summary, `"fileBytes":100`, `"fileBytes":`+strconv.Itoa(r.fileBytes), 1)
	metadata := strings.Replace(validMetadata, `"inputDurationSeconds":1`, `"inputDurationSeconds":2`, 1)
	for name, data := range map[string]string{"feature-timeline.json": timeline, "music-summary.json": summary, "analysis-metadata.json": metadata} {
		if err := os.WriteFile(filepath.Join(output, name), []byte(data), 0600); err != nil {
			return err
		}
	}
	return nil
}

// TestLiveStorageJobRoundTrip is opt-in and runs only against the throwaway
// Step 7k-52 Supabase project prepared by the repository validation script.
func TestLiveStorageJobRoundTrip(t *testing.T) {
	if os.Getenv("ARVC_STEP7K52_LIVE_INTEGRATION") != "1" {
		t.Skip("isolated Step 7k-52 integration environment is not configured")
	}
	dsn := os.Getenv("ARVC_STEP7K52_AUDIO_DSN")
	adminDSN := os.Getenv("ARVC_STEP7K52_ADMIN_DSN")
	storageURL := os.Getenv("ARVC_STEP7K52_STORAGE_URL")
	storageKey := os.Getenv("ARVC_STEP7K52_SERVICE_KEY")
	userID := os.Getenv("ARVC_STEP7K52_USER_ID")
	if dsn == "" || adminDSN == "" || storageURL == "" || storageKey == "" || userID == "" {
		t.Fatal("isolated Step 7k-52 integration settings are incomplete")
	}
	admin, err := pgx.Connect(context.Background(), adminDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	defer func() {
		_, _ = admin.Exec(context.Background(), `DELETE FROM public.audio_analysis_jobs WHERE user_id=$1::uuid`, userID)
		_, _ = admin.Exec(context.Background(), `DELETE FROM public.audio_analysis_storage_intents WHERE user_id=$1::uuid`, userID)
		_, _ = admin.Exec(context.Background(), `DELETE FROM public.audio_analysis_storage_cleanup WHERE user_id=$1::uuid`, userID)
		_, _ = admin.Exec(context.Background(), `DELETE FROM public.audio_analysis_entitlements WHERE user_id=$1::uuid`, userID)
		_, _ = admin.Exec(context.Background(), `DELETE FROM public.audio_analysis_usage WHERE user_id=$1::uuid`, userID)
		_, _ = admin.Exec(context.Background(), `DELETE FROM auth.users WHERE id=$1::uuid`, userID)
		_, _ = admin.Exec(context.Background(), `UPDATE public.audio_analysis_control SET enabled=false,service_daily_limit=0,service_monthly_limit=0,concurrent_limit=0,request_window_limit=0 WHERE singleton`)
	}()
	if _, err := admin.Exec(context.Background(), `INSERT INTO auth.users(id) VALUES($1::uuid)`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(context.Background(), `INSERT INTO public.audio_analysis_entitlements(user_id,enabled,daily_limit,monthly_limit,concurrent_limit,granted_at,expires_at) VALUES($1::uuid,true,10,100,1,now()-interval '1 minute',now()+interval '1 hour')`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(context.Background(), `UPDATE public.audio_analysis_control SET enabled=true,service_daily_limit=10,service_monthly_limit=100,concurrent_limit=2,request_window_seconds=600,request_window_limit=20,lease_seconds=900 WHERE singleton`); err != nil {
		t.Fatal(err)
	}

	store, err := audiojobs.NewPostgres(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	storage, err := audiojobs.NewSupabaseStorage(storageURL, storageKey)
	if err != nil {
		t.Fatal(err)
	}
	info := validInfo()
	info.DurationSeconds = 2
	analysisConfig := Config{TempDirectory: t.TempDir(), Timeout: time.Second, Prober: fakeProber{info: info}, Runner: storageIntegrationRunner{fileBytes: len(makePCM16WAV(2 * 44_100))}, Admission: &fakeAdmission{}}
	if os.Getenv("ARVC_STEP7K52_SCNET_INTEGRATION") == "1" {
		_, thisFile, _, ok := runtime.Caller(0)
		if !ok {
			t.Fatal("cannot locate repository")
		}
		repo := filepath.Clean(filepath.Join(filepath.Dir(thisFile), "../../.."))
		pythonDir := filepath.Join(repo, "python-island")
		pythonExe := filepath.Join(pythonDir, ".venv", "bin", "python-island")
		if _, statErr := os.Stat(pythonExe); statErr != nil {
			t.Skip("existing Python Island environment is unavailable for SCNet integration")
		}
		analysisConfig = Config{PythonExecutable: pythonExe, PythonDirectory: pythonDir, TempDirectory: t.TempDir(), Timeout: 10 * time.Minute, Threads: 1, Admission: &fakeAdmission{}}
	}
	analysis, err := NewHandler(analysisConfig)
	if err != nil {
		t.Fatal(err)
	}
	api, err := NewJobAPI(analysis, store)
	if err != nil {
		t.Fatal(err)
	}
	api.SetStorage(storage)
	e := echo.New()
	api.Register(e, func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			c.SetRequest(c.Request().WithContext(authn.ContextWithPrincipal(c.Request().Context(), authn.Principal{Subject: userID})))
			return next(c)
		}
	})

	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("audio", "clip.wav")
	if err != nil {
		t.Fatal(err)
	}
	audio := makePCM16WAV(2 * 44_100)
	if _, err = part.Write(audio); err != nil {
		t.Fatal(err)
	}
	if err = form.WriteField("kickGateMode", "soft"); err != nil {
		t.Fatal(err)
	}
	if err = form.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/audio/jobs", &body)
	req.Header.Set(echo.HeaderContentType, form.FormDataContentType())
	req.Header.Set("Idempotency-Key", "step7k52-live-storage")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("Storage-backed job submit status=%d body=%s", rec.Code, rec.Body.String())
	}
	var submitted jobStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &submitted); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = storage.Delete(context.Background(), userID+"/"+submitted.JobID+".wav") }()
	items, err := store.ClaimDispatch(context.Background(), 1)
	if err != nil || len(items) != 1 || items[0].JobID != submitted.JobID {
		t.Fatalf("outbox dispatch claim failed: items=%#v err=%v", items, err)
	}
	delivery, job, err := store.ClaimTask(context.Background(), items[0])
	if err != nil || delivery != "claimed" || job.AudioObjectKey == "" || len(job.Audio) != 0 {
		t.Fatalf("Storage-backed worker claim failed: state=%s key=%q audio=%d err=%v", delivery, job.AudioObjectKey, len(job.Audio), err)
	}
	if got, _, err := store.ClaimTask(context.Background(), items[0]); err != nil || got != "busy" {
		t.Fatalf("duplicate active delivery was not fenced: state=%s err=%v", got, err)
	}
	if !api.runClaimed(context.Background(), job) {
		var dbState, safeCode, usageState string
		_ = admin.QueryRow(context.Background(), `SELECT j.state,COALESCE(j.safe_error_code,''),COALESCE(u.state,'') FROM public.audio_analysis_jobs j LEFT JOIN public.audio_analysis_usage u ON u.audio_job_id=j.job_id WHERE j.job_id=$1::uuid`, submitted.JobID).Scan(&dbState, &safeCode, &usageState)
		t.Fatalf("Storage download, SCNet handler, quota, result, or cleanup path failed: state=%q error=%q quota=%q", dbState, safeCode, usageState)
	}
	if err := store.MarkDispatchDone(context.Background(), items[0]); err != nil {
		t.Fatal(err)
	}
	if got, _, err := store.ClaimTask(context.Background(), items[0]); err != nil || got != "stale" {
		t.Fatalf("duplicate terminal delivery was not idempotent: state=%s err=%v", got, err)
	}
	status, err := store.GetStatus(context.Background(), submitted.JobID, userID)
	if err != nil || status.State != "succeeded" {
		var dbState, safeCode, usageState string
		_ = admin.QueryRow(context.Background(), `SELECT j.state,COALESCE(j.safe_error_code,''),COALESCE(u.state,'') FROM public.audio_analysis_jobs j LEFT JOIN public.audio_analysis_usage u ON u.audio_job_id=j.job_id WHERE j.job_id=$1::uuid`, submitted.JobID).Scan(&dbState, &safeCode, &usageState)
		t.Fatalf("job result state=%q database_state=%q safe_error=%q quota_state=%q err=%v", status.State, dbState, safeCode, usageState, err)
	}
	result, err := store.GetResult(context.Background(), submitted.JobID, userID)
	if err != nil || !bytes.Contains(result, []byte(`"featureTimeline"`)) {
		t.Fatalf("result was not saved: bytes=%d err=%v", len(result), err)
	}
	if _, err := storage.Get(context.Background(), userID+"/"+submitted.JobID+".wav"); err == nil {
		t.Fatal("terminal audio object was not cleaned up")
	}
	var usageCount int64
	if err := admin.QueryRow(context.Background(), `SELECT count(*) FROM public.audio_analysis_usage WHERE audio_job_id=$1::uuid`, submitted.JobID).Scan(&usageCount); err != nil {
		t.Fatal(err)
	}
	if usageCount != 1 {
		t.Fatalf("job reserved quota %d times", usageCount)
	}
}
