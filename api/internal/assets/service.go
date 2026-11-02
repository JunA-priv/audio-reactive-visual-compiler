package assets

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/authn"
	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/projects"
	"github.com/labstack/echo/v5"
)

const (
	bucketID      = "arvc-project-assets"
	maxAudioBytes = int64(32 << 20)
	maxImageBytes = int64(10 << 20)
	maxJSONBody   = 64 << 10
)

var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Asset struct {
	ID           string    `json:"id"`
	ProjectID    string    `json:"project_id"`
	OwnerID      string    `json:"owner_id"`
	Kind         string    `json:"kind"`
	OriginalName string    `json:"original_name"`
	ContentType  string    `json:"content_type"`
	ByteSize     int64     `json:"byte_size"`
	SHA256       string    `json:"sha256"`
	Status       string    `json:"status"`
	ObjectKey    string    `json:"object_key"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type assetResponse struct {
	ID           string    `json:"id"`
	ProjectID    string    `json:"projectId"`
	Kind         string    `json:"kind"`
	OriginalName string    `json:"originalName"`
	ContentType  string    `json:"contentType"`
	ByteSize     int64     `json:"byteSize"`
	SHA256       string    `json:"sha256"`
	Status       string    `json:"status"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

func publicAsset(a Asset) assetResponse {
	return assetResponse{ID: a.ID, ProjectID: a.ProjectID, Kind: a.Kind, OriginalName: a.OriginalName, ContentType: a.ContentType, ByteSize: a.ByteSize, SHA256: a.SHA256, Status: a.Status, CreatedAt: a.CreatedAt, UpdatedAt: a.UpdatedAt}
}

type Reservation struct {
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	ByteSize    int64  `json:"byteSize"`
	SHA256      string `json:"sha256"`
}

type Service struct {
	baseURL  string
	apiKey   string
	client   *http.Client
	verifier ReadyFinalizer
}

type ReadyFinalizer interface {
	MarkReady(context.Context, string, string) (Asset, error)
}

type Handler struct {
	service   *Service
	validator *authn.Validator
}

func NewService(baseURL, apiKey string, verifier ReadyFinalizer) (*Service, error) {
	parsed, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || parsed == nil || parsed.Scheme != "http" || parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" || !isLoopback(parsed.Hostname()) {
		return nil, errors.New("Supabase Storage URL must be a loopback HTTP URL")
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("Supabase publishable key is required")
	}
	if verifier == nil {
		return nil, errors.New("server-only asset verifier is required")
	}
	return &Service{baseURL: strings.TrimRight(baseURL, "/"), apiKey: apiKey, client: &http.Client{Timeout: 2 * time.Minute}, verifier: verifier}, nil
}

func NewHandler(service *Service, validator *authn.Validator) *Handler {
	return &Handler{service: service, validator: validator}
}

func (h *Handler) Register(e *echo.Echo) {
	g := e.Group("/api/v1/projects/:projectId/assets", h.validator.Middleware)
	g.POST("", h.reserve)
	g.GET("", h.list)
	g.POST("/:assetId/content", h.upload)
	g.POST("/:assetId/complete", h.complete)
	g.GET("/:assetId", h.get)
	g.GET("/:assetId/content", h.download)
	g.DELETE("/:assetId", h.delete)
}

func (h *Handler) reserve(c *echo.Context) error {
	principal, token, err := principalAndToken(c)
	if err != nil {
		return apiError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	projectID := c.Param("projectId")
	if !uuid(projectID) {
		return apiError(c, http.StatusBadRequest, "invalid_request", "project id must be a UUID")
	}
	var request Reservation
	if err := decodeJSON(c, &request); err != nil {
		return err
	}
	request.Name = safeName(request.Name)
	if request.Name == "" || !hashPattern.MatchString(request.SHA256) || !allowed(request.Kind, request.ContentType, request.ByteSize) {
		return apiError(c, http.StatusUnprocessableEntity, "invalid_asset", "asset metadata, type, hash, or size is invalid")
	}
	if err := h.service.assertProject(c.Request().Context(), token, principal.Subject, projectID); err != nil {
		return repositoryError(c, err)
	}
	asset, err := h.service.reserve(c.Request().Context(), token, principal.Subject, projectID, request)
	if err != nil {
		return repositoryError(c, err)
	}
	return c.JSON(http.StatusCreated, publicAsset(asset))
}

func (h *Handler) list(c *echo.Context) error {
	principal, token, err := principalAndToken(c)
	if err != nil {
		return apiError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	projectID := c.Param("projectId")
	if !uuid(projectID) {
		return apiError(c, http.StatusBadRequest, "invalid_request", "project id must be a UUID")
	}
	rows, err := h.service.list(c.Request().Context(), token, principal.Subject, projectID)
	if err != nil {
		return repositoryError(c, err)
	}
	result := make([]assetResponse, 0, len(rows))
	for _, asset := range rows {
		if asset.Status == "ready" {
			result = append(result, publicAsset(asset))
		}
	}
	return c.JSON(http.StatusOK, map[string]any{"items": result})
}

func (h *Handler) get(c *echo.Context) error {
	asset, err := h.getReadyAsset(c)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, publicAsset(asset))
}

func (h *Handler) upload(c *echo.Context) error {
	principal, token, err := principalAndToken(c)
	if err != nil {
		return apiError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	asset, err := h.service.get(c.Request().Context(), token, principal.Subject, c.Param("projectId"), c.Param("assetId"))
	if err != nil {
		return repositoryError(c, err)
	}
	if asset.Status != "pending_upload" {
		return apiError(c, http.StatusConflict, "asset_not_pending", "asset is not awaiting upload")
	}
	if !uuid(asset.ProjectID) || asset.ProjectID != strings.ToLower(c.Param("projectId")) || !uuid(asset.ID) || asset.ID != strings.ToLower(c.Param("assetId")) {
		return apiError(c, http.StatusNotFound, "not_found", "asset not found")
	}
	if strings.ToLower(strings.TrimSpace(c.Request().Header.Get(echo.HeaderContentType))) != asset.ContentType {
		return apiError(c, http.StatusUnsupportedMediaType, "unsupported_media_type", "upload Content-Type does not match reservation")
	}
	if c.Request().ContentLength > 0 && c.Request().ContentLength != asset.ByteSize {
		return apiError(c, http.StatusUnprocessableEntity, "asset_size_mismatch", "upload size does not match reservation")
	}
	file, actualHash, actualSize, err := spoolAndVerify(c, asset)
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if actualSize != asset.ByteSize || actualHash != asset.SHA256 {
		return apiError(c, http.StatusUnprocessableEntity, "asset_integrity_mismatch", "upload size or SHA-256 does not match reservation")
	}
	if err := validateSignature(file, asset.ContentType); err != nil {
		return apiError(c, http.StatusUnsupportedMediaType, "unsupported_media_type", "file signature does not match the reserved media type")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return apiError(c, http.StatusInternalServerError, "asset_upload_failed", "could not prepare asset upload")
	}
	if err := h.service.upload(c.Request().Context(), token, asset, file); err != nil {
		var statusErr *storageStatusError
		if errors.As(err, &statusErr) {
			slog.Error("local Storage asset upload rejected", "event", "asset_storage_failed", "upstream_http_status", statusErr.status)
		}
		return apiError(c, http.StatusBadGateway, "asset_storage_unavailable", "asset upload did not complete")
	}
	ready, err := h.markReadyIdempotent(c, token, principal.Subject, asset)
	if err != nil {
		return apiError(c, http.StatusBadGateway, "asset_finalize_pending", "upload exists but asset verification is pending; retry completion")
	}
	return c.JSON(http.StatusOK, publicAsset(ready))
}

func (h *Handler) complete(c *echo.Context) error {
	principal, token, err := principalAndToken(c)
	if err != nil {
		return apiError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	asset, err := h.service.get(c.Request().Context(), token, principal.Subject, c.Param("projectId"), c.Param("assetId"))
	if err != nil {
		return repositoryError(c, err)
	}
	if asset.Status == "ready" {
		return c.JSON(http.StatusOK, publicAsset(asset))
	}
	if asset.Status != "pending_upload" {
		return apiError(c, http.StatusConflict, "asset_not_pending", "asset is not awaiting completion")
	}
	if err := h.service.verifyStoredObject(c.Request().Context(), token, asset); err != nil {
		return apiError(c, http.StatusUnprocessableEntity, "asset_integrity_mismatch", "stored object does not match reservation")
	}
	ready, err := h.markReadyIdempotent(c, token, principal.Subject, asset)
	if err != nil {
		return apiError(c, http.StatusBadGateway, "asset_finalize_pending", "asset verification succeeded but finalization is pending")
	}
	return c.JSON(http.StatusOK, publicAsset(ready))
}

func (h *Handler) download(c *echo.Context) error {
	principal, token, err := principalAndToken(c)
	if err != nil {
		return apiError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	asset, err := h.service.get(c.Request().Context(), token, principal.Subject, c.Param("projectId"), c.Param("assetId"))
	if err != nil {
		return repositoryError(c, err)
	}
	if asset.Status != "ready" {
		return apiError(c, http.StatusConflict, "asset_not_ready", "asset is not ready")
	}
	reader, response, err := h.service.openObject(c.Request().Context(), token, asset)
	if err != nil {
		return apiError(c, http.StatusBadGateway, "asset_storage_unavailable", "asset download failed")
	}
	defer response.Body.Close()
	c.Response().Header().Set(echo.HeaderContentType, asset.ContentType)
	c.Response().Header().Set(echo.HeaderContentLength, strconv.FormatInt(asset.ByteSize, 10))
	c.Response().Header().Set("X-Content-Type-Options", "nosniff")
	c.Response().Header().Set("Content-Disposition", `attachment; filename="`+asset.OriginalName+`"`)
	_, copyErr := io.CopyN(c.Response(), reader, asset.ByteSize)
	if copyErr != nil {
		return copyErr
	}
	return nil
}

func (h *Handler) delete(c *echo.Context) error {
	principal, token, err := principalAndToken(c)
	if err != nil {
		return apiError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	if err := h.service.assertAssetUnreferenced(c.Request().Context(), token, principal.Subject, c.Param("projectId"), c.Param("assetId")); err != nil {
		if errors.Is(err, errConflict) {
			return apiError(c, http.StatusConflict, "asset_referenced", "remove the asset reference from the project before deleting it")
		}
		return repositoryError(c, err)
	}
	if err := h.service.deleteAsset(c.Request().Context(), token, principal.Subject, c.Param("projectId"), c.Param("assetId")); err != nil {
		return repositoryError(c, err)
	}
	return c.NoContent(http.StatusNoContent)
}

func (h *Handler) DeleteProjectAssets(ctx context.Context, token, owner, projectID string) error {
	return h.service.deleteProjectAssets(ctx, token, owner, projectID)
}

func (h *Handler) markReadyIdempotent(c *echo.Context, token, owner string, verified Asset) (Asset, error) {
	ready, err := h.service.markReady(c.Request().Context(), verified.ID, owner)
	if err == nil {
		return ready, nil
	}
	// Two complete calls may verify the same bytes concurrently. The database
	// function itself only accepts pending_upload; accept the winner's ready
	// row after rechecking the owner's metadata to keep the HTTP operation safe.
	current, reloadErr := h.service.get(c.Request().Context(), token, owner, verified.ProjectID, verified.ID)
	if reloadErr == nil && current.Status == "ready" && current.SHA256 == verified.SHA256 && current.ByteSize == verified.ByteSize {
		return current, nil
	}
	return Asset{}, err
}

func (h *Handler) getReadyAsset(c *echo.Context) (Asset, error) {
	principal, token, err := principalAndToken(c)
	if err != nil {
		return Asset{}, apiError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	asset, err := h.service.get(c.Request().Context(), token, principal.Subject, c.Param("projectId"), c.Param("assetId"))
	if err != nil {
		return Asset{}, repositoryError(c, err)
	}
	if asset.Status != "ready" {
		return Asset{}, apiError(c, http.StatusNotFound, "not_found", "asset not found")
	}
	return asset, nil
}

func (s *Service) assertProject(ctx context.Context, token, owner, projectID string) error {
	query := url.Values{"select": {"id"}, "id": {"eq." + projectID}, "owner_id": {"eq." + owner}, "limit": {"1"}}
	body, status, err := s.dataRequest(ctx, http.MethodGet, "/rest/v1/projects?"+query.Encode(), token, nil, "")
	if err != nil {
		return err
	}
	if status == http.StatusOK {
		var rows []map[string]any
		if json.Unmarshal(body, &rows) == nil && len(rows) == 1 {
			return nil
		}
		return errNotFound
	}
	return sanitizeUpstreamError(status)
}

func (s *Service) reserve(ctx context.Context, token, owner, projectID string, in Reservation) (Asset, error) {
	payload, _ := json.Marshal(map[string]any{"project_id": projectID, "kind": in.Kind, "original_name": in.Name, "content_type": in.ContentType, "byte_size": in.ByteSize, "sha256": in.SHA256})
	body, status, err := s.dataRequest(ctx, http.MethodPost, "/rest/v1/project_assets?select="+url.QueryEscape("id,project_id,owner_id,kind,original_name,content_type,byte_size,sha256,status,object_key,created_at,updated_at"), token, payload, "return=representation")
	if err != nil {
		return Asset{}, err
	}
	if status < 200 || status >= 300 {
		return Asset{}, sanitizeUpstreamError(status)
	}
	var rows []Asset
	if json.Unmarshal(body, &rows) != nil || len(rows) != 1 || rows[0].OwnerID != owner || rows[0].ProjectID != projectID || !validObjectKey(rows[0]) {
		return Asset{}, errors.New("invalid asset reservation response")
	}
	return rows[0], nil
}

func (s *Service) list(ctx context.Context, token, owner, projectID string) ([]Asset, error) {
	q := url.Values{"select": {"id,project_id,owner_id,kind,original_name,content_type,byte_size,sha256,status,object_key,created_at,updated_at"}, "project_id": {"eq." + projectID}, "owner_id": {"eq." + owner}, "order": {"created_at.asc"}}
	body, status, err := s.dataRequest(ctx, http.MethodGet, "/rest/v1/project_assets?"+q.Encode(), token, nil, "")
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, sanitizeUpstreamError(status)
	}
	var rows []Asset
	if json.Unmarshal(body, &rows) != nil {
		return nil, errors.New("invalid asset list response")
	}
	for _, row := range rows {
		if row.OwnerID != owner || row.ProjectID != projectID || !validObjectKey(row) {
			return nil, errors.New("invalid asset list owner/path")
		}
	}
	return rows, nil
}

func (s *Service) get(ctx context.Context, token, owner, projectID, assetID string) (Asset, error) {
	if !uuid(projectID) || !uuid(assetID) {
		return Asset{}, errNotFound
	}
	q := url.Values{"select": {"id,project_id,owner_id,kind,original_name,content_type,byte_size,sha256,status,object_key,created_at,updated_at"}, "id": {"eq." + assetID}, "project_id": {"eq." + projectID}, "owner_id": {"eq." + owner}, "limit": {"1"}}
	body, status, err := s.dataRequest(ctx, http.MethodGet, "/rest/v1/project_assets?"+q.Encode(), token, nil, "")
	if err != nil {
		return Asset{}, err
	}
	if status < 200 || status >= 300 {
		return Asset{}, sanitizeUpstreamError(status)
	}
	var rows []Asset
	if json.Unmarshal(body, &rows) != nil || len(rows) != 1 {
		return Asset{}, errNotFound
	}
	if rows[0].OwnerID != owner || !validObjectKey(rows[0]) {
		return Asset{}, errNotFound
	}
	return rows[0], nil
}

func (s *Service) rpc(ctx context.Context, token, function string, assetID string) error {
	payload, _ := json.Marshal(map[string]string{"p_asset_id": assetID})
	_, status, err := s.dataRequest(ctx, http.MethodPost, "/rest/v1/rpc/"+function, token, payload, "")
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return sanitizeUpstreamError(status)
	}
	return nil
}

func (s *Service) markReady(ctx context.Context, assetID, owner string) (Asset, error) {
	asset, err := s.verifier.MarkReady(ctx, assetID, owner)
	if err != nil || asset.OwnerID != owner || asset.ID != assetID || asset.Status != "ready" || !validObjectKey(asset) {
		return Asset{}, errors.New("verified asset transition failed")
	}
	return asset, nil
}

func (s *Service) dataRequest(ctx context.Context, method, route, token string, payload []byte, prefer string) ([]byte, int, error) {
	request, err := http.NewRequestWithContext(ctx, method, s.baseURL+route, strings.NewReader(string(payload)))
	if err != nil {
		return nil, 0, errors.New("could not create local Supabase request")
	}
	request.Header.Set("apikey", s.apiKey)
	request.Header.Set("Authorization", "Bearer "+token)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if prefer != "" {
		request.Header.Set("Prefer", prefer)
	}
	response, err := s.client.Do(request)
	if err != nil {
		return nil, 0, errors.New("local Supabase request failed")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return nil, response.StatusCode, errors.New("local Supabase response failed")
	}
	return body, response.StatusCode, nil
}

func (s *Service) storageRequest(ctx context.Context, method, route, token string, body io.Reader, contentType string, contentLength ...int64) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, s.baseURL+route, body)
	if err != nil {
		return nil, errors.New("could not create local Storage request")
	}
	request.Header.Set("apikey", s.apiKey)
	request.Header.Set("Authorization", "Bearer "+token)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	if len(contentLength) == 1 {
		request.ContentLength = contentLength[0]
	}
	response, err := s.client.Do(request)
	if err != nil {
		return nil, errors.New("local Storage request failed")
	}
	return response, nil
}

func (s *Service) upload(ctx context.Context, token string, asset Asset, file *os.File) error {
	response, err := s.storageRequest(ctx, http.MethodPost, "/storage/v1/object/"+bucketID+"/"+escapeKey(asset.ObjectKey), token, file, asset.ContentType, asset.ByteSize)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &storageStatusError{status: response.StatusCode}
	}
	return nil
}

func (s *Service) openObject(ctx context.Context, token string, asset Asset) (io.ReadCloser, *http.Response, error) {
	response, err := s.storageRequest(ctx, http.MethodGet, "/storage/v1/object/authenticated/"+bucketID+"/"+escapeKey(asset.ObjectKey), token, nil, "")
	if err != nil {
		return nil, nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		response.Body.Close()
		return nil, response, fmt.Errorf("storage get status %d", response.StatusCode)
	}
	return response.Body, response, nil
}

func (s *Service) verifyStoredObject(ctx context.Context, token string, asset Asset) error {
	body, _, err := s.openObject(ctx, token, asset)
	if err != nil {
		return err
	}
	defer body.Close()
	hasher := sha256.New()
	count, err := io.Copy(hasher, io.LimitReader(body, asset.ByteSize+1))
	if err != nil || count != asset.ByteSize || hex.EncodeToString(hasher.Sum(nil)) != asset.SHA256 {
		return errors.New("stored object digest mismatch")
	}
	return nil
}

func (s *Service) deleteAsset(ctx context.Context, token, owner, projectID, assetID string) error {
	asset, err := s.get(ctx, token, owner, projectID, assetID)
	if err != nil {
		return &assetPhaseError{phase: "load_metadata", err: err}
	}
	if err := s.rpc(ctx, token, "project_asset_mark_delete_pending", asset.ID); err != nil {
		return &assetPhaseError{phase: "mark_delete_pending", err: err}
	}
	deleteBody, _ := json.Marshal(map[string][]string{"prefixes": {asset.ObjectKey}})
	response, err := s.storageRequest(ctx, http.MethodDelete, "/storage/v1/object/"+bucketID, token, strings.NewReader(string(deleteBody)), "application/json", int64(len(deleteBody)))
	if err != nil {
		return &assetPhaseError{phase: "storage_delete_transport", err: err}
	}
	status := response.StatusCode
	response.Body.Close()
	if status < 200 || status >= 300 {
		// A retry after Storage succeeded but DB finalization failed is safe only
		// after the authenticated endpoint confirms that the exact object is absent.
		if status != http.StatusNotFound {
			return &assetPhaseError{phase: "storage_delete", err: &storageStatusError{status: status}}
		}
	}
	if err := s.rpc(ctx, token, "project_asset_finalize_delete", asset.ID); err != nil {
		return &assetPhaseError{phase: "finalize_metadata_delete", err: err}
	}
	return nil
}

func (s *Service) deleteProjectAssets(ctx context.Context, token, owner, projectID string) error {
	rows, err := s.list(ctx, token, owner, projectID)
	if err != nil {
		return err
	}
	for _, asset := range rows {
		if err := s.deleteAsset(ctx, token, owner, projectID, asset.ID); err != nil {
			var phaseErr *assetPhaseError
			if errors.As(err, &phaseErr) {
				attrs := []any{"event", "asset_delete_failed", "phase", phaseErr.phase}
				var statusErr *storageStatusError
				if errors.As(phaseErr.err, &statusErr) {
					attrs = append(attrs, "upstream_http_status", statusErr.status)
				}
				var repoErr *upstreamError
				if errors.As(phaseErr.err, &repoErr) {
					attrs = append(attrs, "database_api_http_status", repoErr.status)
				}
				slog.Error("local Storage asset deletion did not complete", attrs...)
			}
			return err
		}
	}
	return nil
}

func (s *Service) assertAssetUnreferenced(ctx context.Context, token, owner, projectID, assetID string) error {
	asset, err := s.get(ctx, token, owner, projectID, assetID)
	if err != nil {
		return err
	}
	q := url.Values{"select": {"document"}, "id": {"eq." + projectID}, "owner_id": {"eq." + owner}, "limit": {"1"}}
	body, status, err := s.dataRequest(ctx, http.MethodGet, "/rest/v1/projects?"+q.Encode(), token, nil, "")
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return sanitizeUpstreamError(status)
	}
	var rows []struct {
		Document json.RawMessage `json:"document"`
	}
	if json.Unmarshal(body, &rows) != nil || len(rows) != 1 {
		return errNotFound
	}
	backgroundID, audioID, cloud, err := projects.CloudAssetReferences(rows[0].Document)
	if err != nil {
		return err
	}
	if cloud && (backgroundID == asset.ID || audioID == asset.ID) {
		return errConflict
	}
	return nil
}

func (h *Handler) ValidateProjectRefs(ctx context.Context, token, owner, projectID string, raw json.RawMessage) error {
	backgroundID, audioID, cloud, err := projects.CloudAssetReferences(raw)
	if err != nil || !cloud {
		return err
	}
	for _, item := range []struct{ id, kind string }{{backgroundID, "background_image"}, {audioID, "source_audio"}} {
		if item.id == "" {
			continue
		}
		asset, err := h.service.get(ctx, token, owner, projectID, item.id)
		if err != nil || asset.Status != "ready" || asset.Kind != item.kind {
			return errNotFound
		}
	}
	return nil
}

var errNotFound = errors.New("asset not found")
var errConflict = errors.New("asset is referenced by project")

type assetPhaseError struct {
	phase string
	err   error
}

func (e *assetPhaseError) Error() string { return "asset operation did not complete" }
func (e *assetPhaseError) Unwrap() error { return e.err }

type storageStatusError struct{ status int }

func (e *storageStatusError) Error() string { return "local Storage rejected the asset request" }

func repositoryError(c *echo.Context, err error) error {
	if errors.Is(err, errNotFound) {
		return apiError(c, http.StatusNotFound, "not_found", "asset or project not found")
	}
	if errors.Is(err, errConflict) {
		return apiError(c, http.StatusConflict, "asset_conflict", "asset operation conflicts with current project state")
	}
	var upstream *upstreamError
	if errors.As(err, &upstream) {
		switch upstream.status {
		case http.StatusNotFound:
			return apiError(c, http.StatusNotFound, "not_found", "asset or project not found")
		case http.StatusConflict:
			return apiError(c, http.StatusConflict, "asset_conflict", "asset state or quota conflict")
		case http.StatusRequestEntityTooLarge:
			return apiError(c, http.StatusRequestEntityTooLarge, "asset_too_large", "asset exceeds configured limits")
		case http.StatusBadRequest, http.StatusUnprocessableEntity:
			return apiError(c, http.StatusUnprocessableEntity, "invalid_asset", "asset operation was rejected")
		case http.StatusForbidden, http.StatusUnauthorized:
			return apiError(c, http.StatusNotFound, "not_found", "asset or project not found")
		}
	}
	return apiError(c, http.StatusBadGateway, "asset_store_unavailable", "asset operation failed")
}

type upstreamError struct{ status int }

func (e *upstreamError) Error() string       { return "local asset store rejected request" }
func sanitizeUpstreamError(status int) error { return &upstreamError{status: status} }

func principalAndToken(c *echo.Context) (authn.Principal, string, error) {
	principal, ok := authn.PrincipalFrom(c.Request().Context())
	parts := strings.Fields(c.Request().Header.Get(echo.HeaderAuthorization))
	if !ok || len(parts) != 2 {
		return authn.Principal{}, "", errors.New("unauthorized")
	}
	return principal, parts[1], nil
}

func decodeJSON(c *echo.Context, target any) error {
	if !strings.HasPrefix(strings.ToLower(c.Request().Header.Get(echo.HeaderContentType)), echo.MIMEApplicationJSON) {
		return apiError(c, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json")
	}
	body, err := io.ReadAll(http.MaxBytesReader(c.Response(), c.Request().Body, maxJSONBody))
	if err != nil {
		return apiError(c, http.StatusRequestEntityTooLarge, "request_too_large", "asset metadata request is too large")
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return apiError(c, http.StatusBadRequest, "invalid_request", "request must be one JSON object")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return apiError(c, http.StatusBadRequest, "invalid_request", "request must contain one JSON object")
	}
	return nil
}

func apiError(c *echo.Context, status int, code, message string) error {
	return c.JSON(status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func spoolAndVerify(c *echo.Context, asset Asset) (*os.File, string, int64, error) {
	limit := maxAudioBytes
	if asset.Kind == "background_image" {
		limit = maxImageBytes
	}
	body := http.MaxBytesReader(c.Response(), c.Request().Body, limit+1)
	file, err := os.CreateTemp("", "arvc-asset-*.upload")
	if err != nil {
		return nil, "", 0, apiError(c, http.StatusInternalServerError, "asset_upload_failed", "could not prepare bounded upload")
	}
	hasher := sha256.New()
	count, copyErr := io.Copy(io.MultiWriter(file, hasher), body)
	if copyErr != nil {
		file.Close()
		os.Remove(file.Name())
		var maxErr *http.MaxBytesError
		if errors.As(copyErr, &maxErr) {
			return nil, "", 0, apiError(c, http.StatusRequestEntityTooLarge, "asset_too_large", "asset exceeds configured limits")
		}
		return nil, "", 0, apiError(c, http.StatusBadRequest, "invalid_upload", "upload body could not be read")
	}
	if count > limit {
		file.Close()
		os.Remove(file.Name())
		return nil, "", 0, apiError(c, http.StatusRequestEntityTooLarge, "asset_too_large", "asset exceeds configured limits")
	}
	if err := file.Sync(); err != nil {
		file.Close()
		os.Remove(file.Name())
		return nil, "", 0, apiError(c, http.StatusInternalServerError, "asset_upload_failed", "could not verify upload")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		file.Close()
		os.Remove(file.Name())
		return nil, "", 0, apiError(c, http.StatusInternalServerError, "asset_upload_failed", "could not verify upload")
	}
	return file, hex.EncodeToString(hasher.Sum(nil)), count, nil
}

func validateSignature(file *os.File, contentType string) error {
	var header [16]byte
	n, err := file.Read(header[:])
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	b := header[:n]
	valid := false
	switch contentType {
	case "image/png":
		valid = len(b) >= 8 && string(b[:8]) == "\x89PNG\r\n\x1a\n"
	case "image/jpeg":
		valid = len(b) >= 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff
	case "audio/wav":
		valid = len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WAVE"
	case "audio/ogg", "audio/opus":
		valid = len(b) >= 4 && string(b[:4]) == "OggS"
	case "audio/flac":
		valid = len(b) >= 4 && string(b[:4]) == "fLaC"
	case "audio/mpeg":
		valid = (len(b) >= 3 && string(b[:3]) == "ID3") || (len(b) >= 2 && b[0] == 0xff && b[1]&0xe0 == 0xe0)
	case "audio/aac":
		valid = len(b) >= 2 && b[0] == 0xff && b[1]&0xf6 == 0xf0
	case "audio/mp4":
		valid = len(b) >= 8 && string(b[4:8]) == "ftyp"
	case "audio/webm":
		valid = len(b) >= 4 && string(b[:4]) == "\x1a\x45\xdf\xa3"
	}
	if !valid {
		return errors.New("media signature mismatch")
	}
	return nil
}

func allowed(kind, contentType string, size int64) bool {
	if size < 1 {
		return false
	}
	if kind == "source_audio" {
		_, _, err := mime.ParseMediaType(contentType)
		if err != nil || !strings.HasPrefix(contentType, "audio/") || size > maxAudioBytes {
			return false
		}
		switch contentType {
		case "audio/mpeg", "audio/wav", "audio/ogg", "audio/opus", "audio/mp4", "audio/aac", "audio/webm", "audio/flac":
			return true
		}
	}
	return kind == "background_image" && size <= maxImageBytes && (contentType == "image/png" || contentType == "image/jpeg")
}

func safeName(value string) string {
	value = strings.ReplaceAll(value, "\\", "/")
	value = path.Base(strings.TrimSpace(value))
	if value == "." || value == "/" || len([]rune(value)) > 255 || strings.ContainsAny(value, "\x00\r\n\";") {
		return ""
	}
	return value
}

func validObjectKey(a Asset) bool { return a.ObjectKey == a.OwnerID+"/"+a.ProjectID+"/"+a.ID }
func escapeKey(value string) string {
	parts := strings.Split(value, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return strings.Join(parts, "/")
}
func uuid(value string) bool {
	return len(value) == 36 && value[8] == '-' && value[13] == '-' && value[18] == '-' && value[23] == '-' && strings.Trim(value, "0123456789abcdefABCDEF-") == ""
}
func isLoopback(host string) bool { return host == "localhost" || host == "127.0.0.1" || host == "::1" }
