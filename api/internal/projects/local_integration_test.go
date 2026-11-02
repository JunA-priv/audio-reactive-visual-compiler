package projects_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/authn"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/projects"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/service"
)

type authUser struct {
	ID          string `json:"id"`
	AccessToken string `json:"access_token"`
}

type authResponse struct {
	AccessToken string `json:"access_token"`
	User        struct {
		ID string `json:"id"`
	} `json:"user"`
}

func TestLocalSupabaseProjectAuthorizationAndLimits(t *testing.T) {
	baseURL := strings.TrimRight(os.Getenv("ARVC_LOCAL_SUPABASE_URL"), "/")
	anonKey := os.Getenv("ARVC_LOCAL_SUPABASE_ANON_KEY")
	serviceRoleKey := os.Getenv("ARVC_LOCAL_SUPABASE_SERVICE_ROLE_KEY")
	if baseURL == "" || anonKey == "" || serviceRoleKey == "" {
		t.Skip("set local Supabase test configuration to run integration coverage")
	}
	ctx := context.Background()
	issuer := baseURL + "/auth/v1"
	validator, err := authn.NewValidator(ctx, issuer)
	if err != nil {
		t.Fatal("local Auth JWKS initialization failed")
	}
	defer validator.Close()
	repository, err := projects.NewDataAPI(baseURL, anonKey)
	if err != nil {
		t.Fatal("local Data API initialization failed")
	}
	echo := service.NewServer(service.Config{Mode: "fixture", Projects: projects.NewHandler(repository, validator)})
	server := httptest.NewServer(echo)
	defer server.Close()
	client := &http.Client{Timeout: 10 * time.Second}

	userA := createTestUser(t, client, baseURL, anonKey, serviceRoleKey)
	userB := createTestUser(t, client, baseURL, anonKey, serviceRoleKey)

	if status, _ := requestJSON(t, client, http.MethodGet, server.URL+"/api/v1/projects", "", nil); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated Go API status=%d", status)
	}
	createdStatus, createdBody := requestJSON(t, client, http.MethodPost, server.URL+"/api/v1/projects", userA.AccessToken, map[string]any{"title": "integration project", "document": json.RawMessage(testDocument)})
	if createdStatus != http.StatusCreated {
		t.Fatalf("owner create status=%d", createdStatus)
	}
	var created projects.Project
	if json.Unmarshal(createdBody, &created) != nil || created.ID == "" || created.Revision != 1 || created.OwnerID != "" {
		t.Fatal("create response did not match the public project contract")
	}
	projectURL := server.URL + "/api/v1/projects/" + url.PathEscape(created.ID)
	for _, operation := range []struct {
		name, method string
		body         any
	}{{"get", http.MethodGet, nil}, {"update", http.MethodPut, map[string]any{"title": "forbidden", "revision": 1, "document": json.RawMessage(testDocument)}}, {"delete", http.MethodDelete, nil}} {
		t.Run("cross-owner-"+operation.name, func(t *testing.T) {
			status, _ := requestJSON(t, client, operation.method, projectURL, userB.AccessToken, operation.body)
			if status != http.StatusNotFound {
				t.Fatalf("cross-owner operation status=%d", status)
			}
		})
	}
	getStatus, getBody := requestJSON(t, client, http.MethodGet, projectURL, userA.AccessToken, nil)
	if getStatus != http.StatusOK {
		t.Fatalf("owner get status=%d", getStatus)
	}
	var retrieved projects.Project
	if json.Unmarshal(getBody, &retrieved) != nil || !bytes.Equal(canonicalJSON(t, retrieved.Document), canonicalJSON(t, created.Document)) {
		t.Fatal("stored project document differs from the submitted v1 document")
	}
	updateStatus, updateBody := requestJSON(t, client, http.MethodPut, projectURL, userA.AccessToken, map[string]any{"title": "updated project", "revision": 1, "document": json.RawMessage(testDocument)})
	var updated projects.Project
	if updateStatus != http.StatusOK || json.Unmarshal(updateBody, &updated) != nil || updated.Revision != 2 {
		t.Fatalf("owner update failed with status=%d", updateStatus)
	}
	staleStatus, _ := requestJSON(t, client, http.MethodPut, projectURL, userA.AccessToken, map[string]any{"title": "stale", "revision": 1, "document": json.RawMessage(testDocument)})
	if staleStatus != http.StatusConflict {
		t.Fatalf("stale update status=%d", staleStatus)
	}
	var concurrent sync.WaitGroup
	statuses := make(chan int, 2)
	for index := 0; index < 2; index++ {
		concurrent.Add(1)
		go func(index int) {
			defer concurrent.Done()
			status, _ := requestJSON(t, client, http.MethodPut, projectURL, userA.AccessToken, map[string]any{
				"title": fmt.Sprintf("concurrent-%d", index), "revision": 2, "document": json.RawMessage(testDocument),
			})
			statuses <- status
		}(index)
	}
	concurrent.Wait()
	close(statuses)
	wins := map[int]int{}
	for status := range statuses {
		wins[status]++
	}
	if wins[http.StatusOK] != 1 || wins[http.StatusConflict] != 1 {
		t.Fatalf("concurrent same-revision updates returned statuses=%v", wins)
	}
	deleteStatus, _ := requestJSON(t, client, http.MethodDelete, projectURL, userA.AccessToken, nil)
	if deleteStatus != http.StatusNoContent {
		t.Fatalf("owner delete status=%d", deleteStatus)
	}
	missingStatus, _ := requestJSON(t, client, http.MethodGet, projectURL, userA.AccessToken, nil)
	if missingStatus != http.StatusNotFound {
		t.Fatalf("deleted project lookup status=%d", missingStatus)
	}

	// Direct Data API reads remain owner-filtered by RLS. The anon database role
	// cannot read or write projects, and table UPDATE is intentionally unavailable.
	directURL := baseURL + "/rest/v1/projects?select=id&owner_id=eq." + url.QueryEscape(userA.ID)
	status, body := dataAPIRequest(t, client, http.MethodGet, directURL, anonKey, userB.AccessToken, nil)
	if status != http.StatusOK || len(bytes.TrimSpace(body)) == 0 || string(bytes.TrimSpace(body)) != "[]" {
		t.Fatalf("other owner's direct Data API read status=%d", status)
	}
	status, _ = dataAPIRequest(t, client, http.MethodGet, baseURL+"/rest/v1/projects?select=id", anonKey, anonKey, nil)
	if status != http.StatusUnauthorized && status != http.StatusForbidden {
		t.Fatalf("anon direct Data API read status=%d", status)
	}
	status, _ = dataAPIRequest(t, client, http.MethodGet, baseURL+"/rest/v1/projects?select=id", serviceRoleKey, serviceRoleKey, nil)
	if status != http.StatusUnauthorized && status != http.StatusForbidden {
		t.Fatalf("service_role direct Data API read status=%d", status)
	}
	spoofPayload := []byte(`{"owner_id":"` + userB.ID + `","title":"spoof","document":` + testDocument + `}`)
	status, _ = dataAPIRequest(t, client, http.MethodPost, baseURL+"/rest/v1/projects", anonKey, userA.AccessToken, spoofPayload)
	if status >= 200 && status < 300 {
		t.Fatal("direct Data API accepted owner spoofing")
	}
	status, _ = dataAPIRequest(t, client, http.MethodPatch, baseURL+"/rest/v1/projects?id=eq."+url.QueryEscape(created.ID), anonKey, userA.AccessToken, []byte(`{"title":"bypass revision"}`))
	if status >= 200 && status < 300 {
		t.Fatal("direct table update bypassed the revision RPC")
	}

	// Create 20 rows through the Data API to prove the owner cap also applies
	// when the Go HTTP API is bypassed. The 21st insert must fail in PostgreSQL.
	for index := 0; index < 20; index++ {
		status, _ = dataAPIRequest(t, client, http.MethodPost, baseURL+"/rest/v1/projects", anonKey, userA.AccessToken, []byte(fmt.Sprintf(`{"title":"direct-%02d","document":%s}`, index, testDocument)))
		if status < 200 || status >= 300 {
			t.Fatalf("direct insert %d status=%d", index+1, status)
		}
	}
	status, _ = dataAPIRequest(t, client, http.MethodPost, baseURL+"/rest/v1/projects", anonKey, userA.AccessToken, []byte(`{"title":"twenty-first","document":`+testDocument+`}`))
	if status < 400 {
		t.Fatalf("21st direct insert status=%d", status)
	}
	firstStatus, firstBody := requestJSON(t, client, http.MethodGet, server.URL+"/api/v1/projects?limit=10", userA.AccessToken, nil)
	var firstPage projects.Page
	if firstStatus != http.StatusOK || json.Unmarshal(firstBody, &firstPage) != nil || len(firstPage.Items) != 10 || firstPage.NextCursor == "" {
		t.Fatal("first owner list page did not contain ten projects and a cursor")
	}
	secondStatus, secondBody := requestJSON(t, client, http.MethodGet, server.URL+"/api/v1/projects?limit=10&cursor="+url.QueryEscape(firstPage.NextCursor), userA.AccessToken, nil)
	var secondPage projects.Page
	if secondStatus != http.StatusOK || json.Unmarshal(secondBody, &secondPage) != nil || len(secondPage.Items) != 10 || secondPage.NextCursor != "" {
		t.Fatal("second owner list page did not contain the remaining ten projects")
	}
	seen := make(map[string]bool, 20)
	for _, item := range append(firstPage.Items, secondPage.Items...) {
		if seen[item.ID] {
			t.Fatal("cursor pagination returned a duplicate project")
		}
		seen[item.ID] = true
	}
	limitStatus, _ := requestJSON(t, client, http.MethodGet, server.URL+"/api/v1/projects?limit=21", userA.AccessToken, nil)
	if limitStatus != http.StatusBadRequest {
		t.Fatalf("limit greater than 20 status=%d", limitStatus)
	}

	oversizedDocument := strings.TrimSuffix(testDocument, "}") + `,"padding":"` + strings.Repeat("x", projects.MaxDocumentBytes) + `"}`
	status, _ = dataAPIRequest(t, client, http.MethodPost, baseURL+"/rest/v1/projects", anonKey, userB.AccessToken, []byte(`{"title":"oversize","document":`+oversizedDocument+`}`))
	if status < 400 {
		t.Fatalf("oversized direct Data API document status=%d", status)
	}
}

const testDocument = `{"documentVersion":1,"metadata":{"blueprintSchemaVersion":1,"featureTimelineSchemaVersion":1,"rendererVersion":"editor-renderer/1","analysisVersion":"unknown","seed":1},"blueprint":{"version":1,"width":640,"height":360,"seed":1,"background":{"kind":"solid","color":"#10131c"},"regions":[{"id":"r","name":"stage","geometry":{"kind":"rect","x":0,"y":0,"width":1,"height":1}}],"effects":[{"id":"e","kind":"pulse-scale","regionId":"r","color":"#ffffff","baseScale":0.2,"maxScale":1}],"bindings":[{"id":"b","effectId":"e","source":"bass.envelope","strength":1,"threshold":0,"attackMs":0,"releaseMs":100}]},"featureTimeline":{"schemaVersion":1,"timeUnit":"ms","durationMs":1000,"bassEnvelope":[{"timeMs":0,"value":0.2},{"timeMs":1000,"value":0.8}],"kickEvents":[]}}`

func createTestUser(t *testing.T, client *http.Client, baseURL, anonKey, adminKey string) authUser {
	t.Helper()
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		t.Fatal("could not create local test identity")
	}
	identity := hex.EncodeToString(random)
	credentials, _ := json.Marshal(map[string]string{"email": "step7b-" + identity + "@example.invalid", "password": "LocalOnly-" + identity + "-A9!"})
	status, body := dataAPIRequest(t, client, http.MethodPost, baseURL+"/auth/v1/signup", anonKey, "", credentials)
	if status < 200 || status >= 300 {
		t.Fatalf("local test user signup status=%d", status)
	}
	var response authResponse
	if json.Unmarshal(body, &response) != nil || response.User.ID == "" {
		t.Fatal("local Auth did not return a test user")
	}
	userID := response.User.ID
	t.Cleanup(func() { deleteTestUser(t, client, baseURL, adminKey, userID) })
	if response.AccessToken == "" {
		loginBody, _ := json.Marshal(map[string]string{"email": "step7b-" + identity + "@example.invalid", "password": "LocalOnly-" + identity + "-A9!"})
		status, body = dataAPIRequest(t, client, http.MethodPost, baseURL+"/auth/v1/token?grant_type=password", anonKey, "", loginBody)
		if status < 200 || status >= 300 || json.Unmarshal(body, &response) != nil || response.AccessToken == "" {
			t.Fatalf("local Auth test user login status=%d", status)
		}
	}
	// The admin key is only used by test cleanup, never for Project CRUD.
	return authUser{ID: userID, AccessToken: response.AccessToken}
}

func deleteTestUser(t *testing.T, client *http.Client, baseURL, adminKey, id string) {
	t.Helper()
	if id == "" {
		return
	}
	status, _ := dataAPIRequest(t, client, http.MethodDelete, baseURL+"/auth/v1/admin/users/"+url.PathEscape(id), adminKey, adminKey, nil)
	if status < 200 || status >= 300 {
		t.Errorf("local Auth test-user cleanup status=%d", status)
	}
}

func requestJSON(t *testing.T, client *http.Client, method, endpoint, token string, payload any) (int, []byte) {
	t.Helper()
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatal("test request serialization failed")
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, endpoint, body)
	if err != nil {
		t.Fatal("test request creation failed")
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal("local API request failed")
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	return response.StatusCode, responseBody
}

func dataAPIRequest(t *testing.T, client *http.Client, method, endpoint, apiKey, token string, payload []byte) (int, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, endpoint, bytes.NewReader(payload))
	if err != nil {
		t.Fatal("local Supabase request creation failed")
	}
	request.Header.Set("apikey", apiKey)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Content-Profile", "public")
	request.Header.Set("Accept-Profile", "public")
	if method == http.MethodPost {
		request.Header.Set("Prefer", "return=representation")
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal("local Supabase request failed")
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	return response.StatusCode, body
}

func canonicalJSON(t *testing.T, raw json.RawMessage) []byte {
	t.Helper()
	var value any
	if json.Unmarshal(raw, &value) != nil {
		t.Fatal("project document was not valid JSON")
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		t.Fatal("project document comparison failed")
	}
	return canonical
}
