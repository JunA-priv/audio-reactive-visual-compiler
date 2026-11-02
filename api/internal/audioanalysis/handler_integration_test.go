package audioanalysis

import (
	"bytes"
	"encoding/binary"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"

	"github.com/labstack/echo/v5"
)

func TestAnalyzeThroughLocalPythonIslandCPU(t *testing.T) {
	if os.Getenv("ARVC_AUDIO_ANALYSIS_INTEGRATION") != "1" {
		t.Skip("set ARVC_AUDIO_ANALYSIS_INTEGRATION=1 to run existing local CPU Demucs")
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
	h, err := NewHandler(Config{PythonExecutable: executable, PythonDirectory: pythonDir, TempDirectory: t.TempDir(), Timeout: 10 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	e := echo.New()
	allowLocalTestToken := func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			if c.Request().Header.Get(echo.HeaderAuthorization) != "Bearer local-integration-test" {
				return c.NoContent(http.StatusUnauthorized)
			}
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
