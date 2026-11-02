package projects

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/authn"
	"github.com/labstack/echo/v5"
)

var idPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type Handler struct {
	repository        Repository
	validator         *authn.Validator
	assetCleaner      func(context.Context, string, string, string) error
	assetRefValidator func(context.Context, string, string, string, json.RawMessage) error
}

func NewHandler(repository Repository, validator *authn.Validator) *Handler {
	return &Handler{repository: repository, validator: validator}
}

func (h *Handler) SetAssetCleaner(cleaner func(context.Context, string, string, string) error) {
	h.assetCleaner = cleaner
}

func (h *Handler) SetAssetRefValidator(validator func(context.Context, string, string, string, json.RawMessage) error) {
	h.assetRefValidator = validator
}

func (h *Handler) Register(e *echo.Echo) {
	group := e.Group("/api/v1/projects", h.validator.Middleware)
	group.POST("", h.create)
	group.GET("", h.list)
	group.GET("/:id", h.get)
	group.PUT("/:id", h.update)
	group.DELETE("/:id", h.delete)
}

func (h *Handler) principal(c *echo.Context) (authn.Principal, error) {
	principal, ok := authn.PrincipalFrom(c.Request().Context())
	if !ok {
		return authn.Principal{}, errors.New("unauthorized")
	}
	return principal, nil
}

func (h *Handler) create(c *echo.Context) error {
	principal, err := h.principal(c)
	if err != nil {
		return writeError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	var request CreateRequest
	if err := decodeRequest(c, &request); err != nil {
		return err
	}
	request.Title = strings.TrimSpace(request.Title)
	if err := ValidateTitle(request.Title); err != nil {
		return writeError(c, http.StatusUnprocessableEntity, "invalid_project", err.Error())
	}
	if len(request.Document) > MaxDocumentBytes {
		return writeError(c, http.StatusRequestEntityTooLarge, "project_too_large", "project document exceeds 1 MiB")
	}
	decoded, err := DecodeStoredDocument(request.Document)
	if err != nil {
		return writeError(c, http.StatusUnprocessableEntity, "invalid_project_document", err.Error())
	}
	if decoded.Cloud != nil && (decoded.Cloud.EditorState.BackgroundAssetID != nil || decoded.Cloud.AssetRefs.AudioAssetID != nil) {
		return writeError(c, http.StatusUnprocessableEntity, "invalid_asset_reference", "create the project first, then attach ready assets")
	}
	project, err := h.repository.Create(c.Request().Context(), bearer(c), principal.Subject, request.Title, request.Document)
	if err != nil {
		return writeRepositoryError(c, err)
	}
	return c.JSON(http.StatusCreated, project)
}

func (h *Handler) list(c *echo.Context) error {
	principal, err := h.principal(c)
	if err != nil {
		return writeError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	limit := 20
	if value := c.QueryParam("limit"); value != "" {
		parsed, parseErr := strconv.Atoi(value)
		if parseErr != nil || parsed < 1 || parsed > 20 {
			return writeError(c, http.StatusBadRequest, "invalid_request", "limit must be between 1 and 20")
		}
		limit = parsed
	}
	cursor := c.QueryParam("cursor")
	if len(cursor) > 512 {
		return writeError(c, http.StatusBadRequest, "invalid_request", "cursor is invalid")
	}
	page, err := h.repository.List(c.Request().Context(), bearer(c), principal.Subject, limit, cursor)
	if err != nil {
		return writeRepositoryError(c, err)
	}
	return c.JSON(http.StatusOK, page)
}

func (h *Handler) get(c *echo.Context) error {
	principal, err := h.principal(c)
	if err != nil {
		return writeError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	id := c.Param("id")
	if !idPattern.MatchString(id) {
		return writeError(c, http.StatusBadRequest, "invalid_request", "project id must be a UUID")
	}
	project, err := h.repository.Get(c.Request().Context(), bearer(c), principal.Subject, id)
	if err != nil {
		return writeRepositoryError(c, err)
	}
	return c.JSON(http.StatusOK, project)
}

func (h *Handler) update(c *echo.Context) error {
	principal, err := h.principal(c)
	if err != nil {
		return writeError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	id := c.Param("id")
	if !idPattern.MatchString(id) {
		return writeError(c, http.StatusBadRequest, "invalid_request", "project id must be a UUID")
	}
	var request UpdateRequest
	if err := decodeRequest(c, &request); err != nil {
		return err
	}
	request.Title = strings.TrimSpace(request.Title)
	if err := ValidateTitle(request.Title); err != nil || request.Revision < 1 {
		return writeError(c, http.StatusUnprocessableEntity, "invalid_project", "title and revision are invalid")
	}
	if len(request.Document) > MaxDocumentBytes {
		return writeError(c, http.StatusRequestEntityTooLarge, "project_too_large", "project document exceeds 1 MiB")
	}
	if _, err := DecodeStoredDocument(request.Document); err != nil {
		return writeError(c, http.StatusUnprocessableEntity, "invalid_project_document", err.Error())
	}
	if h.assetRefValidator != nil {
		if err := h.assetRefValidator(c.Request().Context(), bearer(c), principal.Subject, id, request.Document); err != nil {
			return writeError(c, http.StatusUnprocessableEntity, "invalid_asset_reference", "asset reference must identify a ready asset in this project")
		}
	}
	project, err := h.repository.Update(c.Request().Context(), bearer(c), principal.Subject, id, request.Revision, request.Title, request.Document)
	if err != nil {
		return writeRepositoryError(c, err)
	}
	return c.JSON(http.StatusOK, project)
}

func (h *Handler) delete(c *echo.Context) error {
	principal, err := h.principal(c)
	if err != nil {
		return writeError(c, http.StatusUnauthorized, "unauthorized", "valid bearer token required")
	}
	id := c.Param("id")
	if !idPattern.MatchString(id) {
		return writeError(c, http.StatusBadRequest, "invalid_request", "project id must be a UUID")
	}
	if h.assetCleaner != nil {
		if err := h.assetCleaner(c.Request().Context(), bearer(c), principal.Subject, id); err != nil {
			return writeError(c, http.StatusBadGateway, "project_asset_cleanup_failed", "project assets could not be safely removed; retry deletion")
		}
	}
	if err := h.repository.Delete(c.Request().Context(), bearer(c), principal.Subject, id); err != nil {
		return writeRepositoryError(c, err)
	}
	return c.NoContent(http.StatusNoContent)
}

func decodeRequest(c *echo.Context, target any) error {
	contentType := strings.ToLower(c.Request().Header.Get(echo.HeaderContentType))
	if !strings.HasPrefix(contentType, echo.MIMEApplicationJSON) {
		return writeError(c, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json")
	}
	reader := http.MaxBytesReader(c.Response(), c.Request().Body, MaxRequestBytes)
	body, err := io.ReadAll(reader)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return writeError(c, http.StatusRequestEntityTooLarge, "request_too_large", "request exceeds the project document limit")
		}
		return writeError(c, http.StatusBadRequest, "invalid_request", "request body could not be read")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return writeError(c, http.StatusBadRequest, "invalid_request", "request must be one valid JSON object")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return writeError(c, http.StatusBadRequest, "invalid_request", "request must contain exactly one JSON object")
	}
	return nil
}

func bearer(c *echo.Context) string {
	parts := strings.Fields(c.Request().Header.Get(echo.HeaderAuthorization))
	if len(parts) != 2 {
		return ""
	}
	return parts[1]
}

func writeRepositoryError(c *echo.Context, err error) error {
	switch {
	case errors.Is(err, ErrNotFound):
		return writeError(c, http.StatusNotFound, "not_found", "project not found")
	case errors.Is(err, ErrConflict), errors.Is(err, ErrLimit):
		if errors.Is(err, ErrLimit) {
			return writeError(c, http.StatusConflict, "project_limit_reached", "user project limit reached")
		}
		return writeError(c, http.StatusConflict, "revision_conflict", "project revision is stale")
	case errors.Is(err, ErrTooLarge):
		return writeError(c, http.StatusRequestEntityTooLarge, "project_too_large", "project document exceeds 1 MiB")
	case errors.Is(err, ErrInvalid):
		return writeError(c, http.StatusUnprocessableEntity, "invalid_project_document", "database rejected the project document")
	}
	var repoErr *RepositoryError
	if errors.As(err, &repoErr) {
		if repoErr.Constraint == "projects_document_size_limit" {
			return writeError(c, http.StatusRequestEntityTooLarge, "project_too_large", "project document exceeds 1 MiB")
		}
		switch repoErr.Code {
		case "P0001":
			return writeError(c, http.StatusConflict, "project_limit_reached", "user project limit reached")
		case "40001":
			return writeError(c, http.StatusConflict, "revision_conflict", "project revision is stale")
		case "P0002":
			return writeError(c, http.StatusNotFound, "not_found", "project not found")
		case "23514":
			return writeError(c, http.StatusUnprocessableEntity, "invalid_project_document", "database rejected the project document")
		case "42501":
			return writeError(c, http.StatusForbidden, "forbidden", "project operation is not permitted")
		case "22001":
			return writeError(c, http.StatusRequestEntityTooLarge, "project_too_large", "project document exceeds 1 MiB")
		}
	}
	return writeError(c, http.StatusBadGateway, "project_store_unavailable", "local project store request failed")
}

func writeError(c *echo.Context, status int, code, message string) error {
	return c.JSON(status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func ParseBaseURL(value string) (string, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return "", errors.New("invalid Supabase URL")
	}
	return strings.TrimRight(value, "/"), nil
}
