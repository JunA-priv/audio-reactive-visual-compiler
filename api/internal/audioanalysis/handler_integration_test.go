package audioanalysis

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/authn"
	"github.com/labstack/echo/v5"
)

func TestAnalyzeThroughLocalPythonIslandCPU(t *testing.T) {
	if os.Getenv("ARVC_AUDIO_ANALYSIS_INTEGRATION") != "1" {
		t.Skip("set ARVC_AUDIO_ANALYSIS_INTEGRATION=1 to run existing local CPU SCNet")
	}
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate repository")
	}
	repo := filepath.Clean(filepath.Join(filepath.Dir(thisFile), "../../.."))
	pythonDir := filepath.Join(repo, "python-island")
	executable := filepath.Join(pythonDir, ".venv", "bin", "python-island")
	if _, err := os.Stat(executable); err != nil {
		t.Skip("existing Python Island virtual environment is unavailable")
	}
	tempRoot := t.TempDir()
	admission := &fakeAdmission{}
	h, err := NewHandler(Config{PythonExecutable: executable, PythonDirectory: pythonDir, TempDirectory: tempRoot, Timeout: 10 * time.Minute, Admission: admission})
	if err != nil {
		t.Fatal(err)
	}
	e := echo.New()
	allowLocalTestToken := func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			if c.Request().Header.Get(echo.HeaderAuthorization) != "Bearer local-integration-test" {
				return c.NoContent(http.StatusUnauthorized)
			}
			c.SetRequest(c.Request().WithContext(authn.ContextWithPrincipal(c.Request().Context(), authn.Principal{Subject: "00000000-0000-4000-8000-000000000001"})))
			return next(c)
		}
	}
	h.Register(e, allowLocalTestToken)

	clipSeconds := 2
	if raw := os.Getenv("ARVC_AUDIO_ANALYSIS_INTEGRATION_DURATION_SECONDS"); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil || parsed < 1 || parsed > 60 {
			t.Fatalf("integration duration must be an integer from 1 to 60 seconds: %q", raw)
		}
		clipSeconds = parsed
	}
	clip := makePCM16WAV(clipSeconds * 44_100)
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
	req := httptest.NewRequest(http.MethodPost, "/api/v1/audio/analyze", &body)
	req.Header.Set(echo.HeaderContentType, form.FormDataContentType())
	req.Header.Set(echo.HeaderAuthorization, "Bearer local-integration-test")
	response := httptest.NewRecorder()
	e.ServeHTTP(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("analysis failed: status=%d", response.Code)
	}
	expectedDuration := []byte(`"durationMs":` + strconv.Itoa(clipSeconds*1000))
	if !bytes.Contains(response.Body.Bytes(), expectedDuration) || !bytes.Contains(response.Body.Bytes(), []byte(`"analysisMetadata"`)) {
		t.Fatalf("analysis response is missing expected clip metadata")
	}
	var payload struct {
		FeatureTimeline struct {
			SchemaVersion int `json:"schemaVersion"`
		} `json:"featureTimeline"`
		MusicSummary struct {
			Analysis struct {
				Model string `json:"model"`
			} `json:"analysis"`
		} `json:"musicSummary"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("analysis response is not valid JSON: %v", err)
	}
	if payload.FeatureTimeline.SchemaVersion != 1 {
		t.Fatalf("Timeline schemaVersion=%d, want 1", payload.FeatureTimeline.SchemaVersion)
	}
	if payload.MusicSummary.Analysis.Model != "scnet_standard" {
		t.Fatalf("analysis model=%q, want scnet_standard", payload.MusicSummary.Analysis.Model)
	}
	if len(admission.starts) != 1 || len(admission.settlements) != 1 || admission.settlements[0].state != "succeeded" {
		t.Fatalf("quota lifecycle was not completed: starts=%d settlements=%v", len(admission.starts), admission.settlements)
	}
	entries, err := os.ReadDir(tempRoot)
	if err != nil || len(entries) != 0 {
		t.Fatalf("analysis temp directory remained: entries=%d err=%v", len(entries), err)
	}
}

func makePCM16WAV(frames int) []byte {
	const sampleRate = 44_100
	dataBytes := frames * 4
	var out bytes.Buffer
	_, _ = out.WriteString("RIFF")
	_ = binary.Write(&out, binary.LittleEndian, uint32(36+dataBytes))
	_, _ = out.WriteString("WAVEfmt ")
	_ = binary.Write(&out, binary.LittleEndian, uint32(16))
	_ = binary.Write(&out, binary.LittleEndian, uint16(1))
	_ = binary.Write(&out, binary.LittleEndian, uint16(2))
	_ = binary.Write(&out, binary.LittleEndian, uint32(sampleRate))
	_ = binary.Write(&out, binary.LittleEndian, uint32(sampleRate*4))
	_ = binary.Write(&out, binary.LittleEndian, uint16(4))
	_ = binary.Write(&out, binary.LittleEndian, uint16(16))
	_, _ = out.WriteString("data")
	_ = binary.Write(&out, binary.LittleEndian, uint32(dataBytes))
	for frame := 0; frame < frames; frame++ {
		value := int16(6_000 * (frame%200 - 100) / 100)
		_ = binary.Write(&out, binary.LittleEndian, value)
		_ = binary.Write(&out, binary.LittleEndian, value)
	}
	return out.Bytes()
}
