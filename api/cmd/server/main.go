package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/aibudget"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/assets"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/audioanalysis"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/audiobudget"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/audiojobs"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/authn"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/projects"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/service"
	"github.com/labstack/echo/v5"
)

func main() {
	rootCtx, stopSignals := newSignalContext()
	defer stopSignals()
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
	addr, err := resolveListenAddress(os.Getenv("PORT"), os.Getenv("API_ADDR"))
	if err != nil {
		slog.Error("API listen address configuration is invalid")
		os.Exit(1)
	}
	var projectHandler *projects.Handler
	var assetHandler *assets.Handler
	var authValidator *authn.Validator
	var assetVerifier *assets.PostgresVerifier
	var aiBudget *aibudget.Postgres
	var audioBudget *audiobudget.Postgres
	var audioJobs *audiojobs.Postgres
	projectsEnabled := strings.EqualFold(strings.TrimSpace(os.Getenv("PROJECTS_ENABLED")), "true")
	audioAnalysisEnabled := strings.EqualFold(strings.TrimSpace(os.Getenv("AUDIO_ANALYSIS_ENABLED")), "true")
	audioAnalysisJobsEnabled := strings.EqualFold(strings.TrimSpace(os.Getenv("AUDIO_ANALYSIS_JOBS_ENABLED")), "true")
	var audioAnalysisHandler *audioanalysis.Handler
	var audioJobsHandler *audioanalysis.JobAPI
	var workerTaskAuth, schedulerTaskAuth *audioanalysis.GoogleOIDCAuthenticator
	var audioJobsWorkerDone chan struct{}
	if audioAnalysisJobsEnabled && !audioAnalysisEnabled {
		slog.Error("AUDIO_ANALYSIS_ENABLED is required when async audio jobs are enabled")
		os.Exit(1)
	}
	authMode := strings.ToLower(strings.TrimSpace(os.Getenv("AUTH_ENV")))
	if authMode == "" {
		authMode = "local"
	}
	if authMode != "local" && authMode != "hosted" {
		slog.Error("AUTH_ENV must be local or hosted")
		os.Exit(1)
	}
	serviceRole := strings.TrimSpace(os.Getenv("ARVC_SERVICE_ROLE"))
	if serviceRole == "" {
		serviceRole = "api"
	}
	transport := strings.TrimSpace(os.Getenv("AUDIO_ANALYSIS_TRANSPORT"))
	if transport == "" {
		transport = "local"
	}
	cloudTasksEnabled := strings.EqualFold(strings.TrimSpace(os.Getenv("AUDIO_ANALYSIS_CLOUD_TASKS_ENABLED")), "true")
	if (serviceRole != "api" && serviceRole != "worker") || (transport != "local" && transport != "cloud_tasks") {
		slog.Error("audio service role or transport configuration invalid")
		os.Exit(1)
	}
	if audioAnalysisJobsEnabled && authMode == "hosted" && transport != "cloud_tasks" {
		slog.Error("Hosted async jobs require Cloud Tasks transport; refusing local-only configuration")
		os.Exit(1)
	}
	if serviceRole == "worker" && (transport != "cloud_tasks" || !audioAnalysisJobsEnabled || !audioAnalysisEnabled) {
		slog.Error("worker role requires enabled Cloud Tasks audio jobs")
		os.Exit(1)
	}
	if transport == "cloud_tasks" && !cloudTasksEnabled {
		slog.Error("Cloud Tasks transport is disabled until explicitly enabled after deployment readiness")
		os.Exit(1)
	}
	corsOrigins, corsErr := resolveCORSOrigins(os.Getenv("CORS_ALLOWED_ORIGINS"))
	if corsErr != nil {
		slog.Error("CORS origin configuration is invalid")
		os.Exit(1)
	}
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
		authValidator, err = authn.NewValidatorForMode(context.Background(), authMode, issuer)
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
			dsn := strings.TrimSpace(os.Getenv("SUPABASE_AUDIO_ANALYSIS_DSN"))
			if dsn == "" {
				authValidator.Close()
				slog.Error("audio analysis quota store configuration is required")
				os.Exit(1)
			}
			audioBudget, err = audiobudget.NewPostgres(context.Background(), dsn)
			if err != nil {
				authValidator.Close()
				var initErr *audiobudget.InitializationError
				if errors.As(err, &initErr) {
					slog.Error("audio analysis quota store initialization failed", "stage", initErr.Stage, "cause", initErr.Class, "sqlstate", initErr.SQLState)
				} else {
					slog.Error("audio analysis quota store initialization failed")
				}
				os.Exit(1)
			}
			analysisThreads, threadErr := resolveAnalysisThreads(os.Getenv("AUDIO_ANALYSIS_THREADS"))
			if threadErr != nil {
				authValidator.Close()
				audioBudget.Close()
				slog.Error("audio analysis thread configuration is invalid")
				os.Exit(1)
			}
			pythonExecutable := strings.TrimSpace(os.Getenv("PYTHON_ISLAND_EXECUTABLE"))
			if pythonExecutable == "" {
				pythonExecutable = "../python-island/.venv/bin/python-island"
			}
			pythonDirectory := strings.TrimSpace(os.Getenv("PYTHON_ISLAND_DIRECTORY"))
			if pythonDirectory == "" {
				pythonDirectory = "../python-island"
			}
			ffprobeExecutable := strings.TrimSpace(os.Getenv("FFPROBE_EXECUTABLE"))
			audioAnalysisHandler, err = audioanalysis.NewHandler(audioanalysis.Config{PythonExecutable: pythonExecutable, PythonDirectory: pythonDirectory, FFprobeExecutable: ffprobeExecutable, Timeout: audioanalysis.DefaultTimeout, Threads: analysisThreads, Admission: audioBudget})
			if err != nil {
				authValidator.Close()
				audioBudget.Close()
				slog.Error("audio analysis configuration is unavailable")
				os.Exit(1)
			}
			if audioAnalysisJobsEnabled {
				audioJobs, err = audiojobs.NewPostgres(context.Background(), dsn)
				if err != nil {
					authValidator.Close()
					audioBudget.Close()
					slog.Error("audio analysis job store initialization failed")
					os.Exit(1)
				}
				audioJobsHandler, err = audioanalysis.NewJobAPI(audioAnalysisHandler, audioJobs)
				if err != nil {
					authValidator.Close()
					audioBudget.Close()
					audioJobs.Close()
					slog.Error("audio analysis job configuration is unavailable")
					os.Exit(1)
				}
				if transport == "cloud_tasks" {
					workerURL := strings.TrimRight(strings.TrimSpace(os.Getenv("AUDIO_WORKER_URL")), "/")
					invoker := strings.TrimSpace(os.Getenv("CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT"))
					cloudProject, cloudLocation, cloudQueue := strings.TrimSpace(os.Getenv("CLOUD_TASKS_PROJECT")), strings.TrimSpace(os.Getenv("CLOUD_TASKS_LOCATION")), strings.TrimSpace(os.Getenv("CLOUD_TASKS_QUEUE"))
					if workerURL == "" || invoker == "" || cloudProject == "" || cloudLocation == "" || cloudQueue == "" {
						slog.Error("Cloud Tasks transport configuration is incomplete")
						os.Exit(1)
					}
					dispatcher := &audiojobs.OutboxDispatcher{Store: audioJobs, Transport: &audiojobs.CloudTasksREST{Project: cloudProject, Location: cloudLocation, Queue: cloudQueue, WorkerURL: workerURL + "/internal/tasks/audio-analysis", Audience: workerURL, InvokerServiceAccount: invoker, Tokens: audiojobs.MetadataTokenSource{}}}
					audioJobsHandler.SetDispatcher(dispatcher)
					if serviceRole == "worker" {
						workerTaskAuth, err = audioanalysis.NewGoogleOIDCAuthenticator(rootCtx, workerURL, invoker)
						if err != nil {
							slog.Error("worker OIDC configuration invalid")
							os.Exit(1)
						}
						defer workerTaskAuth.Close()
					} else {
						schedulerURL := strings.TrimRight(strings.TrimSpace(os.Getenv("AUDIO_API_URL")), "/")
						schedulerSA := strings.TrimSpace(os.Getenv("CLOUD_SCHEDULER_SERVICE_ACCOUNT"))
						if schedulerURL == "" || schedulerSA == "" {
							slog.Error("Cloud Scheduler wake identity and API URL are required")
							os.Exit(1)
						}
						schedulerTaskAuth, err = audioanalysis.NewGoogleOIDCAuthenticator(rootCtx, schedulerURL, schedulerSA)
						if err != nil {
							slog.Error("scheduler OIDC configuration invalid")
							os.Exit(1)
						}
						defer schedulerTaskAuth.Close()
					}
				}
			}
		}
	}
	var generateAuth func(echo.HandlerFunc) echo.HandlerFunc
	if aiEnabled && authValidator != nil {
		generateAuth = authValidator.Middleware
	}
	e := service.NewServer(service.Config{Mode: mode, Model: model, Generator: generator, Timeout: service.DefaultGenerationTimeout, Projects: projectHandler, GenerateAuth: generateAuth, Budget: aiBudget, LocalFixtureUnlimitedUserID: localFixtureDeveloperID, CORSOrigins: corsOrigins})
	if serviceRole == "worker" {
		e = echo.New()
		e.GET("/healthz", func(c *echo.Context) error { return c.NoContent(http.StatusNoContent) })
		e.POST("/healthz", func(c *echo.Context) error { return c.NoContent(http.StatusNoContent) })
		audioJobsHandler.RegisterTaskWorker(e, workerTaskAuth)
	}
	if serviceRole != "worker" && assetHandler != nil {
		assetHandler.Register(e)
	}
	if serviceRole != "worker" && audioAnalysisHandler != nil {
		audioAnalysisHandler.Register(e, authValidator.Middleware)
	}
	if audioJobsHandler != nil {
		if serviceRole != "worker" {
			audioJobsHandler.Register(e, authValidator.Middleware)
			if schedulerTaskAuth != nil {
				audioJobsHandler.RegisterDispatchWake(e, schedulerTaskAuth)
			}
		}
		if transport == "local" {
			audioJobsWorkerDone = make(chan struct{})
			go func() { defer close(audioJobsWorkerDone); audioJobsHandler.RunQueue(rootCtx) }()
		}
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
	if audioBudget != nil {
		defer audioBudget.Close()
	}
	if audioJobs != nil {
		defer audioJobs.Close()
	}
	slog.Info("API server starting", "addr", addr, "audio_analysis_enabled", audioAnalysisEnabled, "audio_analysis_jobs_enabled", audioAnalysisJobsEnabled)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		slog.Error("API server listener failed", "error", err)
		os.Exit(1)
	}
	server := &http.Server{
		Addr:        addr,
		Handler:     handlerWithRootContext(rootCtx, e),
		ErrorLog:    slog.NewLogLogger(e.Logger.Handler(), slog.LevelError),
		ReadTimeout: 30 * time.Second,
	}
	if err := serveUntilShutdown(rootCtx, server, listener, 8*time.Second); err != nil {
		slog.Error("API server stopped", "error", err)
		os.Exit(1)
	}
	if audioJobsWorkerDone != nil {
		select {
		case <-audioJobsWorkerDone:
		case <-time.After(7 * time.Second):
			slog.Warn("audio analysis job worker shutdown exceeded grace period")
		}
	}
}

func resolveCORSOrigins(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	seen := map[string]bool{}
	var origins []string
	for _, item := range strings.Split(raw, ",") {
		origin := strings.TrimSpace(item)
		if origin == "" || seen[origin] || service.ValidateHostedOrigin(origin) != nil {
			return nil, errors.New("invalid CORS origin")
		}
		seen[origin] = true
		origins = append(origins, origin)
	}
	return origins, nil
}

func resolveListenAddress(port, configuredAddress string) (string, error) {
	port = strings.TrimSpace(port)
	if port != "" {
		parsed, err := strconv.Atoi(port)
		if err != nil || parsed < 1 || parsed > 65535 {
			return "", errors.New("PORT must be an integer from 1 to 65535")
		}
		return net.JoinHostPort("0.0.0.0", strconv.Itoa(parsed)), nil
	}

	addr := strings.TrimSpace(configuredAddress)
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil || (host != "127.0.0.1" && host != "localhost" && host != "::1") {
		return "", errors.New("API_ADDR must bind to loopback when PORT is unset")
	}
	return addr, nil
}

func resolveAnalysisThreads(raw string) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return 4, nil
	}
	threads, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || threads < 1 || threads > 16 {
		return 0, errors.New("AUDIO_ANALYSIS_THREADS must be an integer from 1 to 16")
	}
	return threads, nil
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
