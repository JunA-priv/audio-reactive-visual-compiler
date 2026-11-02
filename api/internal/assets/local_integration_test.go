package assets_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/assets"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/authn"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/projects"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/service"
)

type testUser struct {
	ID          string `json:"id"`
	AccessToken string `json:"access_token"`
}
type testAuthResponse struct {
	AccessToken string `json:"access_token"`
	User        struct {
		ID string `json:"id"`
	} `json:"user"`
}

func TestLocalSupabaseAssetsOwnerStorageAndProjectDelete(t *testing.T) {
	baseURL := strings.TrimRight(os.Getenv("ARVC_LOCAL_SUPABASE_URL"), "/")
	anonKey := os.Getenv("ARVC_LOCAL_SUPABASE_ANON_KEY")
	adminKey := os.Getenv("ARVC_LOCAL_SUPABASE_SERVICE_ROLE_KEY")
	verifierDSN := os.Getenv("ARVC_LOCAL_SUPABASE_ASSET_VERIFIER_DSN")
	if baseURL == "" || anonKey == "" || adminKey == "" || verifierDSN == "" {
		t.Skip("set local Supabase URL, anon key, test-only service key, and dedicated verifier DSN to run Storage integration")
	}
	if !strings.HasPrefix(baseURL, "http://127.0.0.1:") && !strings.HasPrefix(baseURL, "http://localhost:") {
		t.Fatal("integration test requires the verified localhost Supabase URL")
	}
	ctx := context.Background()
	validator, err := authn.NewValidator(ctx, baseURL+"/auth/v1")
	if err != nil {
		t.Fatal("local Auth validator initialization failed")
	}
	defer validator.Close()
	projectRepo, err := projects.NewDataAPI(baseURL, anonKey)
	if err != nil {
		t.Fatal("local Project Data API initialization failed")
	}
	verifier, err := assets.NewPostgresVerifier(verifierDSN)
	if err != nil {
		t.Fatal("local asset verifier initialization failed")
	}
	defer verifier.Close()
	assetService, err := assets.NewService(baseURL, anonKey, verifier)
	if err != nil {
		t.Fatal("local Asset service initialization failed")
	}
	projectHandler := projects.NewHandler(projectRepo, validator)
	assetHandler := assets.NewHandler(assetService, validator)
	projectHandler.SetAssetCleaner(assetHandler.DeleteProjectAssets)
	projectHandler.SetAssetRefValidator(assetHandler.ValidateProjectRefs)
	echoServer := service.NewServer(service.Config{Mode: "fixture", Projects: projectHandler})
	assetHandler.Register(echoServer)
	server := httptest.NewServer(echoServer)
	defer server.Close()
	client := &http.Client{Timeout: 30 * time.Second}

	userA := createAssetTestUser(t, client, baseURL, anonKey, adminKey)
	userB := createAssetTestUser(t, client, baseURL, anonKey, adminKey)
	defer deleteAssetTestUser(t, client, baseURL, adminKey, userA.ID)
	defer deleteAssetTestUser(t, client, baseURL, adminKey, userB.ID)

	project := createTestProject(t, client, server.URL, userA.AccessToken)
	defer func() {
		_, _ = doJSON(client, http.MethodDelete, server.URL+"/api/v1/projects/"+project.ID, userA.AccessToken, nil)
	}()

	audio := []byte("RIFF\x00\x00\x00\x00WAVEdata")
	wrongAsset := reserveTestAsset(t, client, server.URL, userA.AccessToken, project.ID, "source_audio", "tampered.wav", "audio/wav", audio)
	wrong := append([]byte(nil), audio...)
	wrong[len(wrong)-1] ^= 1
	wrongKey := userA.ID + "/" + project.ID + "/" + wrongAsset.ID
	status, _ := storageRequest(client, http.MethodPost, baseURL+"/storage/v1/object/arvc-project-assets/"+wrongKey, anonKey, userA.AccessToken, bytes.NewReader(wrong), "audio/wav")
	if status < 200 || status >= 300 {
		t.Fatalf("owner direct Storage upload to reservation status=%d", status)
	}
	status, _ = doJSON(client, http.MethodPost, server.URL+assetPath(project.ID, wrongAsset.ID)+"/complete", userA.AccessToken, map[string]any{})
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("Go complete accepted wrong stored digest status=%d", status)
	}
	rpcTarget := baseURL + "/rest/v1/rpc/project_asset_mark_ready"
	for _, caller := range []struct {
		name, key, token string
	}{{"authenticated", anonKey, userA.AccessToken}, {"anon", anonKey, anonKey}, {"service_role", adminKey, adminKey}} {
		status, _ = doSupabaseJSON(client, http.MethodPost, rpcTarget, caller.key, caller.token, map[string]any{"p_asset_id": wrongAsset.ID})
		if status < 400 {
			t.Fatalf("%s direct ready RPC status=%d", caller.name, status)
		}
	}
	status, _ = doSupabaseJSONWithHeaders(client, http.MethodPost, rpcTarget, anonKey, userA.AccessToken, map[string]any{"p_asset_id": wrongAsset.ID}, map[string]string{"Content-Profile": "arvc_internal"})
	if status < 400 {
		t.Fatalf("private-schema RPC was exposed through PostgREST status=%d", status)
	}
	status, _ = doJSON(client, http.MethodDelete, server.URL+assetPath(project.ID, wrongAsset.ID), userA.AccessToken, nil)
	if status != http.StatusNoContent {
		t.Fatalf("tampered reservation cleanup status=%d", status)
	}

	audioAsset := reserveTestAsset(t, client, server.URL, userA.AccessToken, project.ID, "source_audio", "tone.wav", "audio/wav", audio)
	status, _ = doBinary(client, http.MethodPost, server.URL+assetPath(project.ID, audioAsset.ID)+"/content", userA.AccessToken, "audio/wav", audio)
	if status != http.StatusOK {
		key := userA.ID + "/" + project.ID + "/" + audioAsset.ID
		directStatus, directBody := storageRequest(client, http.MethodPost, baseURL+"/storage/v1/object/arvc-project-assets/"+key, anonKey, userA.AccessToken, bytes.NewReader(audio), "audio/wav")
		t.Fatalf("audio upload/finalize status=%d direct Storage status=%d category=%s", status, directStatus, safeStorageErrorCategory(directBody))
	}
	status, _ = doJSON(client, http.MethodPost, server.URL+assetPath(project.ID, audioAsset.ID)+"/complete", userA.AccessToken, map[string]any{})
	if status != http.StatusOK {
		t.Fatalf("idempotent audio complete status=%d", status)
	}
	if _, err := verifier.MarkReady(context.Background(), audioAsset.ID, userA.ID); err == nil {
		t.Fatal("database verifier accepted a ready-to-ready transition")
	}
	if _, err := verifier.MarkReady(context.Background(), audioAsset.ID, userB.ID); err == nil {
		t.Fatal("database verifier accepted another owner's asset")
	}
	changed := append([]byte(nil), audio...)
	changed[len(changed)-1] ^= 1
	status, _ = storageRequestWithHeaders(client, http.MethodPost, baseURL+"/storage/v1/object/arvc-project-assets/"+userA.ID+"/"+project.ID+"/"+audioAsset.ID, anonKey, userA.AccessToken, bytes.NewReader(changed), "audio/wav", map[string]string{"x-upsert": "true"})
	if status < 400 {
		t.Fatalf("ready object overwrite status=%d", status)
	}

	concurrentProject := createTestProject(t, client, server.URL, userA.AccessToken)
	defer func() {
		_, _ = doJSON(client, http.MethodDelete, server.URL+"/api/v1/projects/"+concurrentProject.ID, userA.AccessToken, nil)
	}()
	concurrentAsset := reserveTestAsset(t, client, server.URL, userA.AccessToken, concurrentProject.ID, "source_audio", "concurrent.wav", "audio/wav", audio)
	concurrentKey := userA.ID + "/" + concurrentProject.ID + "/" + concurrentAsset.ID
	status, _ = storageRequest(client, http.MethodPost, baseURL+"/storage/v1/object/arvc-project-assets/"+concurrentKey, anonKey, userA.AccessToken, bytes.NewReader(audio), "audio/wav")
	if status < 200 || status >= 300 {
		t.Fatalf("concurrent fixture Storage upload status=%d", status)
	}
	completeStatuses := make(chan int, 2)
	for i := 0; i < 2; i++ {
		go func() {
			status, _ := doJSON(client, http.MethodPost, server.URL+assetPath(concurrentProject.ID, concurrentAsset.ID)+"/complete", userA.AccessToken, map[string]any{})
			completeStatuses <- status
		}()
	}
	for i := 0; i < 2; i++ {
		if status = <-completeStatuses; status != http.StatusOK {
			t.Fatalf("concurrent complete status=%d", status)
		}
	}

	png := []byte("\x89PNG\r\n\x1a\n")
	imageAsset := reserveTestAsset(t, client, server.URL, userA.AccessToken, project.ID, "background_image", "cover.png", "image/png", png)
	status, _ = doBinary(client, http.MethodPost, server.URL+assetPath(project.ID, imageAsset.ID)+"/content", userA.AccessToken, "image/png", png)
	if status != http.StatusOK {
		t.Fatalf("image upload/finalize status=%d", status)
	}

	// Owner-scoped API and Storage direct access both deny user B.
	status, _ = doJSON(client, http.MethodGet, server.URL+assetPath(project.ID, audioAsset.ID), userB.AccessToken, nil)
	if status != http.StatusNotFound {
		t.Fatalf("cross-owner asset API status=%d", status)
	}
	key := userA.ID + "/" + project.ID + "/" + audioAsset.ID
	status, _ = storageRequest(client, http.MethodGet, baseURL+"/storage/v1/object/authenticated/arvc-project-assets/"+key, anonKey, userB.AccessToken, nil, "")
	if status < 400 {
		t.Fatalf("cross-owner direct Storage GET status=%d", status)
	}
	status, _ = storageRequest(client, http.MethodGet, baseURL+"/storage/v1/object/authenticated/arvc-project-assets/"+key, anonKey, anonKey, nil, "")
	if status < 400 {
		t.Fatalf("anon direct Storage GET status=%d", status)
	}

	status, body := doJSON(client, http.MethodGet, server.URL+assetPath(project.ID, audioAsset.ID)+"/content", userA.AccessToken, nil)
	if status != http.StatusOK || !bytes.Equal(body, audio) {
		t.Fatal("owner download did not return exact bytes")
	}

	cloudDocument := cloudEnvelope(audioAsset.ID, imageAsset.ID)
	status, _ = doJSON(client, http.MethodPut, server.URL+"/api/v1/projects/"+project.ID, userA.AccessToken, map[string]any{"title": "asset project", "revision": 1, "document": cloudDocument})
	if status != http.StatusOK {
		t.Fatalf("cloud envelope update status=%d", status)
	}
	status, _ = doJSON(client, http.MethodPut, server.URL+"/api/v1/projects/"+project.ID, userA.AccessToken, map[string]any{"title": "bad ref", "revision": 2, "document": cloudEnvelope(audioAsset.ID, "00000000-0000-4000-8000-000000000099")})
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("foreign/missing asset reference status=%d", status)
	}
	status, _ = doJSON(client, http.MethodDelete, server.URL+assetPath(project.ID, imageAsset.ID), userA.AccessToken, nil)
	if status != http.StatusConflict {
		t.Fatalf("referenced asset delete status=%d", status)
	}

	// The existing Project DELETE now removes Storage objects before the FK rows,
	// and remains retryable when invoked again after completion.
	status, _ = doJSON(client, http.MethodDelete, server.URL+"/api/v1/projects/"+project.ID, userA.AccessToken, nil)
	if status != http.StatusNoContent {
		t.Fatalf("project cascade delete status=%d", status)
	}
	status, _ = doJSON(client, http.MethodGet, server.URL+"/api/v1/projects/"+project.ID, userA.AccessToken, nil)
	if status != http.StatusNotFound {
		t.Fatalf("deleted project lookup status=%d", status)
	}
	status, _ = storageRequest(client, http.MethodGet, baseURL+"/storage/v1/object/authenticated/arvc-project-assets/"+key, anonKey, userA.AccessToken, nil, "")
	if status < 400 {
		t.Fatalf("project deletion left an accessible object, status=%d", status)
	}
}

func createAssetTestUser(t *testing.T, client *http.Client, baseURL, anonKey, adminKey string) testUser {
	t.Helper()
	email := fmt.Sprintf("arvc-step7c-%d@example.invalid", time.Now().UnixNano())
	password := fmt.Sprintf("Arvc-%d-Xy9!", time.Now().UnixNano())
	status, body := doSupabaseJSON(client, http.MethodPost, baseURL+"/auth/v1/admin/users", anonKey, adminKey, map[string]any{"email": email, "password": password, "email_confirm": true})
	if status < 200 || status >= 300 {
		t.Fatalf("local Auth test user create status=%d", status)
	}
	var created struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(body, &created) != nil || created.ID == "" {
		t.Fatal("local Auth user response invalid")
	}
	status, body = doSupabaseJSON(client, http.MethodPost, baseURL+"/auth/v1/token?grant_type=password", anonKey, anonKey, map[string]any{"email": email, "password": password})
	if status < 200 || status >= 300 {
		t.Fatalf("local Auth test login status=%d", status)
	}
	var auth testAuthResponse
	if json.Unmarshal(body, &auth) != nil || auth.AccessToken == "" || auth.User.ID != created.ID {
		t.Fatal("local Auth token response invalid")
	}
	return testUser{ID: created.ID, AccessToken: auth.AccessToken}
}

func deleteAssetTestUser(t *testing.T, client *http.Client, baseURL, adminKey, id string) {
	t.Helper()
	request, _ := http.NewRequest(http.MethodDelete, baseURL+"/auth/v1/admin/users/"+url.PathEscape(id), nil)
	request.Header.Set("apikey", adminKey)
	request.Header.Set("Authorization", "Bearer "+adminKey)
	response, err := client.Do(request)
	if err != nil {
		t.Error("local Auth test user cleanup failed")
		return
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		t.Errorf("local Auth test user cleanup status=%d", response.StatusCode)
	}
}

func createTestProject(t *testing.T, client *http.Client, serverURL, token string) projects.Project {
	t.Helper()
	status, body := doJSON(client, http.MethodPost, serverURL+"/api/v1/projects", token, map[string]any{"title": "asset integration", "document": json.RawMessage(testProjectDocument)})
	var project projects.Project
	if status != http.StatusCreated || json.Unmarshal(body, &project) != nil || project.ID == "" {
		t.Fatalf("test project create status=%d", status)
	}
	return project
}

func reserveTestAsset(t *testing.T, client *http.Client, serverURL, token, projectID, kind, name, contentType string, data []byte) assets.Asset {
	t.Helper()
	digest := sha256.Sum256(data)
	status, body := doJSON(client, http.MethodPost, serverURL+"/api/v1/projects/"+projectID+"/assets", token, map[string]any{"kind": kind, "name": name, "contentType": contentType, "byteSize": len(data), "sha256": hex.EncodeToString(digest[:])})
	var result assets.Asset
	if status != http.StatusCreated {
		t.Fatalf("asset reservation status=%d body=%s", status, string(body))
	}
	if json.Unmarshal(body, &result) != nil || result.ID == "" {
		t.Fatal("asset reservation response invalid")
	}
	return result
}

func assetPath(projectID, assetID string) string {
	return "/api/v1/projects/" + projectID + "/assets/" + assetID
}
func doJSON(client *http.Client, method, target, token string, payload any) (int, []byte) {
	var body io.Reader
	if payload != nil {
		encoded, _ := json.Marshal(payload)
		body = bytes.NewReader(encoded)
	}
	request, _ := http.NewRequest(method, target, body)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, nil
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	return response.StatusCode, data
}
func doBinary(client *http.Client, method, target, token, contentType string, data []byte) (int, []byte) {
	request, _ := http.NewRequest(method, target, bytes.NewReader(data))
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := client.Do(request)
	if err != nil {
		return 0, nil
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	return response.StatusCode, body
}
func doSupabaseJSON(client *http.Client, method, target, apiKey, auth string, payload any) (int, []byte) {
	return doSupabaseJSONWithHeaders(client, method, target, apiKey, auth, payload, nil)
}
func doSupabaseJSONWithHeaders(client *http.Client, method, target, apiKey, auth string, payload any, extra map[string]string) (int, []byte) {
	body, _ := json.Marshal(payload)
	request, _ := http.NewRequest(method, target, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("apikey", apiKey)
	request.Header.Set("Authorization", "Bearer "+auth)
	for name, value := range extra {
		request.Header.Set(name, value)
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, nil
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	return response.StatusCode, data
}
func storageRequest(client *http.Client, method, target, apiKey, token string, body io.Reader, contentType string) (int, []byte) {
	return storageRequestWithHeaders(client, method, target, apiKey, token, body, contentType, nil)
}
func storageRequestWithHeaders(client *http.Client, method, target, apiKey, token string, body io.Reader, contentType string, extra map[string]string) (int, []byte) {
	request, _ := http.NewRequest(method, target, body)
	request.Header.Set("apikey", apiKey)
	request.Header.Set("Authorization", "Bearer "+token)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	for name, value := range extra {
		request.Header.Set(name, value)
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, nil
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	return response.StatusCode, data
}
func cloudEnvelope(audioID, imageID string) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"cloudDocumentVersion":1,"metadata":{"blueprintSchemaVersion":1,"featureTimelineSchemaVersion":1,"rendererVersion":"editor-renderer/1","analysisVersion":"unknown","seed":1},"editorState":{"blueprint":{"version":1,"width":640,"height":360,"seed":1,"background":{"kind":"solid","color":"#000000"},"regions":[{"id":"r","name":"stage","geometry":{"kind":"rect","x":0,"y":0,"width":1,"height":1}}],"effects":[{"id":"e","kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1}],"bindings":[{"id":"b","effectId":"e","source":"bass.envelope","strength":1,"threshold":0,"attackMs":0,"releaseMs":100}]},"backgroundAssetId":%s},"featureTimeline":{"schemaVersion":1,"timeUnit":"ms","durationMs":1000,"bassEnvelope":[{"timeMs":0,"value":0.2},{"timeMs":1000,"value":0.8}],"kickEvents":[]},"assetRefs":{"audioAssetId":"%s"}}`, jsonStringOrNull(imageID), audioID))
}
func jsonStringOrNull(v string) string {
	if v == "" {
		return "null"
	}
	encoded, _ := json.Marshal(v)
	return string(encoded)
}

func safeStorageErrorCategory(body []byte) string {
	message := strings.ToLower(string(body))
	switch {
	case strings.Contains(message, "row-level security"), strings.Contains(message, "rls"):
		return "rls_policy"
	case strings.Contains(message, "mime") || strings.Contains(message, "content type"):
		return "mime_policy"
	case strings.Contains(message, "size") || strings.Contains(message, "too large"):
		return "size_policy"
	case strings.Contains(message, "bucket"):
		return "bucket_configuration"
	case strings.Contains(message, "already exists") || strings.Contains(message, "duplicate"):
		return "object_conflict"
	default:
		return "other"
	}
}

const testProjectDocument = `{"documentVersion":1,"metadata":{"blueprintSchemaVersion":1,"featureTimelineSchemaVersion":1,"rendererVersion":"editor-renderer/1","analysisVersion":"unknown","seed":1},"blueprint":{"version":1,"width":640,"height":360,"seed":1,"background":{"kind":"solid","color":"#10131c"},"regions":[{"id":"r","name":"stage","geometry":{"kind":"rect","x":0,"y":0,"width":1,"height":1}}],"effects":[{"id":"e","kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1}],"bindings":[{"id":"b","effectId":"e","source":"bass.envelope","strength":1,"threshold":0,"attackMs":0,"releaseMs":100}]},"featureTimeline":{"schemaVersion":1,"timeUnit":"ms","durationMs":1000,"bassEnvelope":[{"timeMs":0,"value":0.2},{"timeMs":1000,"value":0.8}],"kickEvents":[]}}`
