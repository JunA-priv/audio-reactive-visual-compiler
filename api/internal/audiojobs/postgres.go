// Package audiojobs owns the persistent control-plane for asynchronous audio
// analyses. SCNet payloads remain private in PostgreSQL and are returned only
// by owner-checked RPCs or worker claims.
package audiojobs

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/audiobudget"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrUnavailable = errors.New("audio job store unavailable")
var ErrNotFound = errors.New("audio job not found")

type Job struct {
	ID              string `json:"jobId"`
	State           string `json:"state"`
	Attempt         int    `json:"-"`
	QueuePosition   int64  `json:"queuePosition,omitempty"`
	Result          []byte `json:"-"`
	SafeError       string `json:"errorCode,omitempty"`
	CancelRequested bool   `json:"cancelRequested,omitempty"`
	UserID          string `json:"-"`
	Audio           []byte `json:"-"`
	AudioObjectKey  string `json:"-"`
	RequestHash     []byte `json:"-"`
	KickGateMode    string `json:"-"`
}

type Store interface {
	Submit(context.Context, string, string, []byte, []byte, string) (string, bool, error)
	GetStatus(context.Context, string, string) (Job, error)
	GetResult(context.Context, string, string) ([]byte, error)
	Cancel(context.Context, string, string) (string, error)
	Claim(context.Context) (Job, bool, error)
	CancelRequested(context.Context, string, string) (bool, error)
	FinishAttempt(context.Context, string, int, string, []byte, string) error
	RetryAttempt(context.Context, string, int) error
	ReserveForJob(context.Context, string, int, string) (string, error)
	StartForJob(context.Context, string, int, string) error
	ReleaseForJob(context.Context, string, int, string) error
	SettleForJob(context.Context, string, int, string, string, string) error
	Close()
}

type Postgres struct{ pool *pgxpool.Pool }

// DispatchItem is the minimal, non-sensitive Cloud Tasks payload identity.
type DispatchItem struct {
	JobID      string `json:"jobId"`
	Generation int    `json:"generation"`
}
type DispatchStore interface {
	ClaimDispatch(context.Context, int) ([]DispatchItem, error)
	MarkDispatchSent(context.Context, DispatchItem, string) error
	MarkDispatchFailed(context.Context, DispatchItem, string) error
	ClaimTask(context.Context, DispatchItem) (string, Job, error)
	MarkDispatchDone(context.Context, DispatchItem) error
}

type StorageJobStore interface {
	CreateStorageIntent(context.Context, string, string, []byte, string, int, string) (string, string, string, error)
	SubmitStored(context.Context, string, string, []byte, string, string) (string, bool, error)
	ClaimedObject(context.Context, string, int) (string, []byte, error)
	ClaimStorageCleanup(context.Context, int) ([]string, error)
	FinishStorageCleanup(context.Context, string) error
	RetryStorageCleanup(context.Context, string, string) error
}

func NewJobUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

func NewPostgres(ctx context.Context, dsn string) (*Postgres, error) {
	cfg, err := pgxpool.ParseConfig(strings.TrimSpace(dsn))
	if err != nil || cfg.ConnConfig.User != "arvc_audio_analysis" {
		return nil, ErrUnavailable
	}
	host := strings.Trim(cfg.ConnConfig.Host, "[]")
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		tls := cfg.ConnConfig.TLSConfig
		if tls == nil || tls.InsecureSkipVerify || tls.ServerName != cfg.ConnConfig.Host {
			return nil, ErrUnavailable
		}
	}
	cfg.MaxConns, cfg.MinConns = 4, 0
	cfg.ConnConfig.ConnectTimeout = 3 * time.Second
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, ErrUnavailable
	}
	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		var netErr net.Error
		if errors.As(err, &netErr) {
			return nil, ErrUnavailable
		}
		return nil, ErrUnavailable
	}
	return &Postgres{pool: pool}, nil
}

func (p *Postgres) Close() {
	if p != nil && p.pool != nil {
		p.pool.Close()
	}
}

func (p *Postgres) ClaimDispatch(ctx context.Context, limit int) ([]DispatchItem, error) {
	if p == nil || p.pool == nil {
		return nil, ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	rows, err := p.pool.Query(ctx, `SELECT job_id::text,generation FROM arvc_internal.audio_analysis_job_dispatch_claim($1)`, limit)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer rows.Close()
	items := make([]DispatchItem, 0, limit)
	for rows.Next() {
		var i DispatchItem
		if err := rows.Scan(&i.JobID, &i.Generation); err != nil {
			return nil, ErrUnavailable
		}
		items = append(items, i)
	}
	if rows.Err() != nil {
		return nil, ErrUnavailable
	}
	return items, nil
}
func (p *Postgres) MarkDispatchSent(ctx context.Context, i DispatchItem, task string) error {
	return p.dispatchBool(ctx, `SELECT arvc_internal.audio_analysis_job_dispatch_sent($1::uuid,$2,$3)`, i.JobID, i.Generation, task)
}
func (p *Postgres) MarkDispatchFailed(ctx context.Context, i DispatchItem, code string) error {
	return p.dispatchBool(ctx, `SELECT arvc_internal.audio_analysis_job_dispatch_failed($1::uuid,$2,$3)`, i.JobID, i.Generation, code)
}
func (p *Postgres) MarkDispatchDone(ctx context.Context, i DispatchItem) error {
	return p.dispatchBool(ctx, `SELECT arvc_internal.audio_analysis_job_dispatch_done($1::uuid,$2)`, i.JobID, i.Generation)
}
func (p *Postgres) dispatchBool(ctx context.Context, sql string, args ...any) error {
	if p == nil || p.pool == nil {
		return ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var ok bool
	if err := p.pool.QueryRow(ctx, sql, args...).Scan(&ok); err != nil || !ok {
		return ErrUnavailable
	}
	return nil
}
func (p *Postgres) ClaimTask(ctx context.Context, i DispatchItem) (string, Job, error) {
	if p == nil || p.pool == nil {
		return "", Job{}, ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var result string
	var id, user, gate pgtype.Text
	var audio []byte
	var attempt pgtype.Int4
	err := p.pool.QueryRow(ctx, `SELECT task_result,job_id::text,user_id::text,audio_wav,kick_gate_mode,attempt FROM arvc_internal.audio_analysis_job_claim_task($1::uuid,$2)`, i.JobID, i.Generation).Scan(&result, &id, &user, &audio, &gate, &attempt)
	if err != nil {
		return "", Job{}, ErrUnavailable
	}
	j := Job{ID: id.String, UserID: user.String, Audio: audio, KickGateMode: gate.String, Attempt: int(attempt.Int32)}
	if j.ID != "" && j.Attempt > 0 {
		j.AudioObjectKey, j.RequestHash, err = p.ClaimedObject(ctx, j.ID, j.Attempt)
		if err != nil {
			return "", Job{}, err
		}
	}
	return result, j, nil
}

func (p *Postgres) CreateStorageIntent(ctx context.Context, userID, key string, hash []byte, jobID string, size int, gate string) (string, string, string, error) {
	if p == nil || p.pool == nil {
		return "", "", "", ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var state string
	var id, object pgtype.Text
	err := p.pool.QueryRow(ctx, `SELECT result,job_id::text,object_key FROM arvc_internal.audio_analysis_storage_intent($1::uuid,$2,$3,$4::uuid,$5,$6)`, userID, key, hash, jobID, size, gate).Scan(&state, &id, &object)
	if err != nil {
		return "", "", "", ErrUnavailable
	}
	if state == "upload" {
		return state, id.String, object.String, nil
	}
	if state == "existing" {
		return state, id.String, object.String, nil
	}
	if state == "existing_legacy" {
		return state, id.String, "", nil
	}
	return "", "", "", errors.New(state)
}

func (p *Postgres) SubmitStored(ctx context.Context, userID, key string, hash []byte, jobID, gate string) (string, bool, error) {
	if p == nil || p.pool == nil {
		return "", false, ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var state string
	var id pgtype.Text
	if err := p.pool.QueryRow(ctx, `SELECT result,job_id::text FROM arvc_internal.audio_analysis_job_submit_storage($1::uuid,$2,$3,$4::uuid,$5)`, userID, key, hash, jobID, gate).Scan(&state, &id); err != nil {
		return "", false, ErrUnavailable
	}
	if (state == "queued" || state == "existing") && id.Valid {
		return id.String, state == "existing", nil
	}
	return "", false, errors.New(state)
}

func (p *Postgres) ClaimedObject(ctx context.Context, jobID string, attempt int) (string, []byte, error) {
	if p == nil || p.pool == nil {
		return "", nil, ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var key pgtype.Text
	var hash []byte
	err := p.pool.QueryRow(ctx, `SELECT object_key,request_hash FROM arvc_internal.audio_analysis_job_storage_ref($1::uuid,$2)`, jobID, attempt).Scan(&key, &hash)
	if err != nil {
		return "", nil, ErrUnavailable
	}
	return key.String, hash, nil
}

func (p *Postgres) ClaimStorageCleanup(ctx context.Context, limit int) ([]string, error) {
	if p == nil || p.pool == nil {
		return nil, ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	rows, err := p.pool.Query(ctx, `SELECT object_key FROM arvc_internal.audio_analysis_storage_cleanup_claim($1)`, limit)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer rows.Close()
	keys := []string{}
	for rows.Next() {
		var k string
		if rows.Scan(&k) != nil {
			return nil, ErrUnavailable
		}
		keys = append(keys, k)
	}
	if rows.Err() != nil {
		return nil, ErrUnavailable
	}
	return keys, nil
}
func (p *Postgres) FinishStorageCleanup(ctx context.Context, key string) error {
	return p.cleanupBool(ctx, `SELECT arvc_internal.audio_analysis_storage_cleanup_done($1)`, key)
}
func (p *Postgres) RetryStorageCleanup(ctx context.Context, key, code string) error {
	return p.cleanupBool(ctx, `SELECT arvc_internal.audio_analysis_storage_cleanup_failed($1,$2)`, key, code)
}
func (p *Postgres) cleanupBool(ctx context.Context, query string, args ...any) error {
	if p == nil || p.pool == nil {
		return ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var ok bool
	if err := p.pool.QueryRow(ctx, query, args...).Scan(&ok); err != nil || !ok {
		return ErrUnavailable
	}
	return nil
}

func (p *Postgres) Submit(ctx context.Context, userID, key string, hash, audio []byte, gate string) (string, bool, error) {
	if p == nil || p.pool == nil {
		return "", false, ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var state string
	var id pgtype.Text
	err := p.pool.QueryRow(ctx, `SELECT result,job_id::text FROM arvc_internal.audio_analysis_job_submit($1::uuid,$2,$3,$4,$5)`, userID, key, hash, audio, gate).Scan(&state, &id)
	if err != nil {
		return "", false, ErrUnavailable
	}
	switch state {
	case "queued":
		if !id.Valid {
			return "", false, ErrUnavailable
		}
		return id.String, false, nil
	case "existing":
		if !id.Valid {
			return "", false, ErrUnavailable
		}
		return id.String, true, nil
	default:
		return "", false, errors.New(state)
	}
}

func (p *Postgres) GetStatus(ctx context.Context, jobID, userID string) (Job, error) {
	if p == nil || p.pool == nil {
		return Job{}, ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var j Job
	err := p.pool.QueryRow(ctx, `SELECT job_id::text,state,queue_position,COALESCE(safe_error_code,''),cancel_requested FROM arvc_internal.audio_analysis_job_status($1::uuid,$2::uuid)`, jobID, userID).Scan(&j.ID, &j.State, &j.QueuePosition, &j.SafeError, &j.CancelRequested)
	if errors.Is(err, pgx.ErrNoRows) {
		return Job{}, ErrNotFound
	}
	if err != nil {
		return Job{}, ErrUnavailable
	}
	return j, nil
}

func (p *Postgres) GetResult(ctx context.Context, jobID, userID string) ([]byte, error) {
	if p == nil || p.pool == nil {
		return nil, ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var result []byte
	err := p.pool.QueryRow(ctx, `SELECT result::text FROM arvc_internal.audio_analysis_job_get($1::uuid,$2::uuid) WHERE state='succeeded'`, jobID, userID).Scan(&result)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, ErrUnavailable
	}
	return result, nil
}

func (p *Postgres) Cancel(ctx context.Context, jobID, userID string) (string, error) {
	if p == nil || p.pool == nil {
		return "", ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var result string
	if err := p.pool.QueryRow(ctx, `SELECT result FROM arvc_internal.audio_analysis_job_cancel($1::uuid,$2::uuid)`, jobID, userID).Scan(&result); err != nil {
		return "", ErrUnavailable
	}
	return result, nil
}

func (p *Postgres) Claim(ctx context.Context) (Job, bool, error) {
	if p == nil || p.pool == nil {
		return Job{}, false, ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var j Job
	err := p.pool.QueryRow(ctx, `SELECT job_id::text,user_id::text,audio_wav,kick_gate_mode,attempt FROM arvc_internal.audio_analysis_job_claim_v2()`).Scan(&j.ID, &j.UserID, &j.Audio, &j.KickGateMode, &j.Attempt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Job{}, false, nil
	}
	if err != nil {
		return Job{}, false, ErrUnavailable
	}
	j.AudioObjectKey, j.RequestHash, err = p.ClaimedObject(ctx, j.ID, j.Attempt)
	if err != nil {
		return Job{}, false, err
	}
	return j, true, nil
}

func (p *Postgres) CancelRequested(ctx context.Context, id, userID string) (bool, error) {
	if p == nil || p.pool == nil {
		return false, ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var requested bool
	err := p.pool.QueryRow(ctx, `SELECT arvc_internal.audio_analysis_job_cancel_requested($1::uuid,$2::uuid)`, id, userID).Scan(&requested)
	if err != nil {
		return false, ErrUnavailable
	}
	return requested, nil
}

func (p *Postgres) FinishAttempt(ctx context.Context, id string, attempt int, state string, result []byte, safeError string) error {
	if p == nil || p.pool == nil {
		return ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var ok bool
	if err := p.pool.QueryRow(ctx, `SELECT arvc_internal.audio_analysis_job_finish_attempt($1::uuid,$2,$3,$4::jsonb,NULLIF($5,''))`, id, attempt, state, nullIfEmpty(result), safeError).Scan(&ok); err != nil || !ok {
		return ErrUnavailable
	}
	return nil
}

func (p *Postgres) RetryAttempt(ctx context.Context, id string, attempt int) error {
	if p == nil || p.pool == nil {
		return ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var ok bool
	if err := p.pool.QueryRow(ctx, `SELECT arvc_internal.audio_analysis_job_requeue_attempt($1::uuid,$2)`, id, attempt).Scan(&ok); err != nil || !ok {
		return ErrUnavailable
	}
	return nil
}

func (p *Postgres) ReserveForJob(ctx context.Context, jobID string, attempt int, userID string) (string, error) {
	if p == nil || p.pool == nil {
		return "", ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var result string
	var id pgtype.Text
	err := p.pool.QueryRow(ctx, `SELECT result,reservation_id::text FROM arvc_internal.audio_analysis_job_quota_reserve($1::uuid,$2,$3::uuid)`, jobID, attempt, userID).Scan(&result, &id)
	if err != nil {
		return "", ErrUnavailable
	}
	if result != "reserved" || !id.Valid {
		return "", quotaResultError(result)
	}
	return id.String, nil
}

func (p *Postgres) StartForJob(ctx context.Context, jobID string, attempt int, reservationID string) error {
	if p == nil || p.pool == nil {
		return ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var result string
	if err := p.pool.QueryRow(ctx, `SELECT arvc_internal.audio_analysis_job_quota_start($1::uuid,$2,$3::uuid)`, jobID, attempt, reservationID).Scan(&result); err != nil {
		return ErrUnavailable
	}
	if result != "started" {
		return quotaResultError(result)
	}
	return nil
}

func (p *Postgres) ReleaseForJob(ctx context.Context, jobID string, attempt int, reservationID string) error {
	if p == nil || p.pool == nil {
		return ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var ok bool
	if err := p.pool.QueryRow(ctx, `SELECT arvc_internal.audio_analysis_job_quota_release($1::uuid,$2,$3::uuid)`, jobID, attempt, reservationID).Scan(&ok); err != nil || !ok {
		return ErrUnavailable
	}
	return nil
}

func (p *Postgres) SettleForJob(ctx context.Context, jobID string, attempt int, reservationID, state, safeCode string) error {
	if p == nil || p.pool == nil {
		return ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var ok bool
	if err := p.pool.QueryRow(ctx, `SELECT arvc_internal.audio_analysis_job_quota_settle($1::uuid,$2,$3::uuid,$4,NULLIF($5,''))`, jobID, attempt, reservationID, state, safeCode).Scan(&ok); err != nil || !ok {
		return ErrUnavailable
	}
	return nil
}

func quotaResultError(result string) error {
	switch result {
	case "disabled":
		return audiobudget.ErrDisabled
	case "not_entitled":
		return audiobudget.ErrNotEntitled
	case "quota_exceeded":
		return audiobudget.ErrQuotaExceeded
	case "concurrency_exceeded":
		return audiobudget.ErrConcurrency
	case "rate_limited":
		return audiobudget.ErrRateLimited
	case "expired":
		return audiobudget.ErrExpired
	case "invalid":
		return audiobudget.ErrInvalid
	default:
		return ErrUnavailable
	}
}

func nullIfEmpty(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return string(value)
}

// HashPayload matches the database's content-bound idempotency check.
func HashPayload(audio []byte, gate string) []byte {
	sum := sha256.Sum256(append(append([]byte(nil), audio...), []byte("|"+gate)...))
	return sum[:]
}

func HashHex(audio []byte, gate string) string { return hex.EncodeToString(HashPayload(audio, gate)) }

var _ Store = (*Postgres)(nil)

func bounded(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, 3*time.Second)
}
