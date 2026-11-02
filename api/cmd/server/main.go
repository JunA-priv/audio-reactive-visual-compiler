package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strings"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/aibudget"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/audioanalysis"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/assets"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/authn"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/projects"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/service"
	"github.com/labstack/echo/v5"
)

func main() {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("BLUEPRINT_MODE")))
	if mode == "" {
		mode = "fixture"
	}
	model := strings.TrimSpace(os.Getenv("OPENAI_MODEL"))
	if model == "" {
		model = service.OpenAIModel
	}
	aiEnabled := strings.EqualFold(strings.TrimSpace(os.Getenv("AI_GENERATION_ENABLED")), "true")
	localFixtureUnlimited := strings.EqualFold(strings.TrimSpace(os.Getenv("AI_FIXTURE_UNLIMITED_LOCAL")), "true")
	localFixtureDeveloperID := strings.ToLower(strings.TrimSpace(os.Getenv("AI_FIXTURE_UNLIMITED_USER_ID")))
	if model != service.OpenAIModel {
		slog.Error("OPENAI_MODEL is not in the server allowlist")
		os.Exit(1)
	}
	if mode != "fixture" && mode != "openai" {
		slog.Error("BLUEPRINT_MODE is invalid")
		os.Exit(1)
	}
	if mode == "openai" && !aiEnabled {
		slog.Error("AI_GENERATION_ENABLED is required for OpenAI mode")
		os.Exit(1)
	}
	var exemptionErr error
	localFixtureDeveloperID, exemptionErr = resolveLocalFixtureDeveloperID(localFixtureUnlimited, aiEnabled, mode, localFixtureDeveloperID)
	if exemptionErr != nil {
		slog.Error("local fixture exemption configuration is invalid")
		os.Exit(1)
	}
	var generator service.Generator
	if mode == "openai" {
		key := strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
		if key != "" {
			g, err := service.NewOpenAIGenerator(key, model)
			if err != nil {
				slog.Error("OpenAI client initialization failed")
				os.Exit(1)
			}
			generator = g
		} else {
			slog.Error("OpenAI API key is required for OpenAI mode")
			os.Exit(1)
		}
	}
	addr := strings.TrimSpace(os.Getenv("API_ADDR"))
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	if !strings.HasPrefix(addr, "127.0.0.1:") && !strings.HasPrefix(addr, "localhost:") {
		slog.Error("API_ADDR must bind to loopback for this local-only implementation")
		os.Exit(1)
	}
	var projectHandler *projects.Handler
	var assetHandler *assets.Handler
	var authValidator *authn.Validator
	var assetVerifier *assets.PostgresVerifier
	var aiBudget *aibudget.Postgres
	projectsEnabled := strings.EqualFold(strings.TrimSpace(os.Getenv("PROJECTS_ENABLED")), "true")
	audioAnalysisEnabled := strings.EqualFold(strings.TrimSpace(os.Getenv("AUDIO_ANALYSIS_ENABLED")), "true")
	var audioAnalysisHandler *audioanalysis.Handler
	if projectsEnabled || aiEnabled || audioAnalysisEnabled {
		supabaseURL := strings.TrimRight(strings.TrimSpace(os.Getenv("SUPABASE_URL")), "/")
		if supabaseURL == "" {
			supabaseURL = "http://127.0.0.1:54321"
		}
		issuer := strings.TrimRight(strings.TrimSpace(os.Getenv("SUPABASE_ISSUER")), "/")
		if issuer == "" {
			issuer = supabaseURL + "/auth/v1"
		}
		var err error
		authValidator, err = authn.NewValidator(context.Background(), issuer)
		if err != nil {
			slog.Error("Project JWT validator initialization failed")
			os.Exit(1)
		}
		if projectsEnabled {
			repository, err := projects.NewDataAPI(supabaseURL, strings.TrimSpace(os.Getenv("SUPABASE_ANON_KEY")))
			if err != nil {
				authValidator.Close()
				slog.Error("Project Data API initialization failed")
				os.Exit(1)
			}
			projectHandler = projects.NewHandler(repository, authValidator)
			verifierDSN := strings.TrimSpace(os.Getenv("SUPABASE_ASSET_VERIFIER_DSN"))
			if verifierDSN == "" {
				authValidator.Close()
				slog.Error("Project Asset verifier configuration is required")
				os.Exit(1)
			}
			assetVerifier, err = assets.NewPostgresVerifier(verifierDSN)
			if err != nil {
				authValidator.Close()
				slog.Error("Project Asset verifier initialization failed")
				os.Exit(1)
			}
			assetService, err := assets.NewService(supabaseURL, strings.TrimSpace(os.Getenv("SUPABASE_ANON_KEY")), assetVerifier)
			if err != nil {
				authValidator.Close()
				assetVerifier.Close()
				slog.Error("Project Asset service initialization failed")
				os.Exit(1)
			}
			assetHandler = assets.NewHandler(assetService, authValidator)
			projectHandler.SetAssetCleaner(assetHandler.DeleteProjectAssets)
			projectHandler.SetAssetRefValidator(assetHandler.ValidateProjectRefs)
		}
		if aiEnabled {
			dsn := strings.TrimSpace(os.Getenv("SUPABASE_AI_BUDGET_DSN"))
			if dsn == "" {
				authValidator.Close()
				slog.Error("AI budget store configuration is required")
				os.Exit(1)
			}
			aiBudget, err = aibudget.NewPostgres(context.Background(), dsn)
			if err != nil {
				authValidator.Close()
				slog.Error("AI budget store initialization failed")
				os.Exit(1)
			}
		}
		if audioAnalysisEnabled {
			pythonExecutable := strings.TrimSpace(os.Getenv("PYTHON_ISLAND_EXECUTABLE"))
			if pythonExecutable == "" { pythonExecutable = "../python-island/.venv/bin/python-island" }
			pythonDirectory := strings.TrimSpace(os.Getenv("PYTHON_ISLAND_DIRECTORY"))
			if pythonDirectory == "" { pythonDirectory = "../python-island" }
			ffprobeExecutable := strings.TrimSpace(os.Getenv("FFPROBE_EXECUTABLE"))
			audioAnalysisHandler, err = audioanalysis.NewHandler(audioanalysis.Config{PythonExecutable: pythonExecutable, PythonDirectory: pythonDirectory, FFprobeExecutable: ffprobeExecutable, Timeout: audioanalysis.DefaultTimeout})
			if err != nil {
				authValidator.Close()
				slog.Error("local audio analysis configuration is unavailable")
				os.Exit(1)
			}
		}
	}
	var generateAuth func(echo.HandlerFunc) echo.HandlerFunc
	if aiEnabled && authValidator != nil {
		generateAuth = authValidator.Middleware
	}
	e := service.NewServer(service.Config{Mode: mode, Model: model, Generator: generator, Timeout: service.DefaultGenerationTimeout, Projects: projectHandler, GenerateAuth: generateAuth, Budget: aiBudget, LocalFixtureUnlimitedUserID: localFixtureDeveloperID})
	if assetHandler != nil {
		assetHandler.Register(e)
	}
	if audioAnalysisHandler != nil {
		audioAnalysisHandler.Register(e, authValidator.Middleware)
	}
	if authValidator != nil {
		defer authValidator.Close()
	}
	if assetVerifier != nil {
		defer assetVerifier.Close()
	}
	if aiBudget != nil {
		defer aiBudget.Close()
	}
	slog.Info("API server starting", "addr", addr, "audio_analysis_enabled", audioAnalysisEnabled)
	if err := e.Start(addr); err != nil && err != http.ErrServerClosed {
		slog.Error("API server stopped", "error", err)
		os.Exit(1)
	}
}

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func resolveLocalFixtureDeveloperID(enabled, aiEnabled bool, mode, userID string) (string, error) {
	if !enabled {
		return "", nil
	}
	userID = strings.ToLower(strings.TrimSpace(userID))
	if !aiEnabled || mode != "fixture" || !uuidPattern.MatchString(userID) {
		return "", errors.New("invalid local fixture exemption configuration")
	}
	return userID, nil
}
