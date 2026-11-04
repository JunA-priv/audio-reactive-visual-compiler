package audiobudget

import (
	"context"
	"errors"
	"net"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrUnavailable   = errors.New("audio analysis budget unavailable")
	ErrDisabled      = errors.New("audio analysis disabled")
	ErrNotEntitled   = errors.New("audio analysis entitlement required")
	ErrQuotaExceeded = errors.New("audio analysis quota exceeded")
	ErrConcurrency   = errors.New("audio analysis concurrency limit reached")
	ErrRateLimited   = errors.New("audio analysis rate limited")
	ErrExpired       = errors.New("audio analysis reservation expired")
	ErrInvalid       = errors.New("audio analysis reservation invalid")
)

const (
	StateSucceeded   = "succeeded"
	StateFailed      = "failed"
	StateCanceled    = "canceled"
	operationTimeout = 3 * time.Second
)

type Reservation struct{ ID string }

// InitializationError contains only safe diagnostic categories. It deliberately
// omits the underlying driver error, which may include connection details.
type InitializationError struct {
	Stage    string
	Class    string
	SQLState string
}

func (e *InitializationError) Error() string { return ErrUnavailable.Error() }
func (e *InitializationError) Unwrap() error { return ErrUnavailable }

func initializationFailure(stage string, cause error) *InitializationError {
	e := &InitializationError{Stage: stage, Class: "other"}
	if errors.Is(cause, context.DeadlineExceeded) {
		e.Class = "timeout"
		return e
	}
	var pgErr *pgconn.PgError
	if errors.As(cause, &pgErr) {
		e.Class = "postgres"
		e.SQLState = pgErr.Code
		return e
	}
	var dnsErr *net.DNSError
	if errors.As(cause, &dnsErr) {
		e.Class = "dns"
		return e
	}
	var netErr net.Error
	if errors.As(cause, &netErr) && netErr.Timeout() {
		e.Class = "timeout"
		return e
	}
	var opErr *net.OpError
	if errors.As(cause, &opErr) {
		e.Class = "network"
	}
	return e
}

type Store interface {
	Reserve(context.Context, string) (Reservation, error)
	Start(context.Context, string) error
	Release(context.Context, string) error
	Settle(context.Context, string, string, string) error
	Close()
}

type Postgres struct{ pool *pgxpool.Pool }

func NewPostgres(ctx context.Context, dsn string) (*Postgres, error) {
	cfg, err := parseConfig(dsn)
	if err != nil {
		return nil, &InitializationError{Stage: "configuration", Class: "rejected"}
	}
	cfg.MaxConns = 4
	cfg.MinConns = 0
	cfg.ConnConfig.ConnectTimeout = operationTimeout
	p, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, initializationFailure("pool", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	if err := p.Ping(pingCtx); err != nil {
		p.Close()
		return nil, initializationFailure("ping", err)
	}
	return &Postgres{pool: p}, nil
}

func parseConfig(dsn string) (*pgxpool.Config, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, ErrUnavailable
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil || cfg.ConnConfig.User != "arvc_audio_analysis" {
		return nil, ErrUnavailable
	}
	host := strings.Trim(cfg.ConnConfig.Host, "[]")
	local := host == "127.0.0.1" || host == "localhost" || host == "::1"
	if !local {
		// pgx uses ServerName with normal certificate verification only for
		// sslmode=verify-full; other TLS modes skip hostname verification.
		if cfg.ConnConfig.TLSConfig == nil || cfg.ConnConfig.TLSConfig.InsecureSkipVerify || cfg.ConnConfig.TLSConfig.ServerName != cfg.ConnConfig.Host {
			return nil, ErrUnavailable
		}
	}
	return cfg, nil
}

func (p *Postgres) Close() {
	if p != nil && p.pool != nil {
		p.pool.Close()
	}
}

func (p *Postgres) Reserve(ctx context.Context, userID string) (Reservation, error) {
	if p == nil || p.pool == nil {
		return Reservation{}, ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var result string
	var id pgtype.Text
	err := p.pool.QueryRow(ctx, `SELECT result, reservation_id::text FROM arvc_internal.audio_analysis_reserve($1::uuid)`, userID).Scan(&result, &id)
	if err != nil {
		return Reservation{}, ErrUnavailable
	}
	if result != "reserved" || !id.Valid {
		return Reservation{}, mapResult(result)
	}
	return Reservation{ID: id.String}, nil
}

func (p *Postgres) Start(ctx context.Context, id string) error {
	if p == nil || p.pool == nil {
		return ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var result string
	if err := p.pool.QueryRow(ctx, `SELECT arvc_internal.audio_analysis_start($1::uuid)`, id).Scan(&result); err != nil {
		return ErrUnavailable
	}
	if result != "started" {
		return mapResult(result)
	}
	return nil
}

func (p *Postgres) Release(ctx context.Context, id string) error {
	if p == nil || p.pool == nil {
		return ErrUnavailable
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var ok bool
	if err := p.pool.QueryRow(ctx, `SELECT arvc_internal.audio_analysis_release($1::uuid)`, id).Scan(&ok); err != nil || !ok {
		return ErrUnavailable
	}
	return nil
}

func (p *Postgres) Settle(ctx context.Context, id, state, safeCode string) error {
	if p == nil || p.pool == nil {
		return ErrUnavailable
	}
	if state != StateSucceeded && state != StateFailed && state != StateCanceled {
		return ErrInvalid
	}
	ctx, cancel := bounded(ctx)
	defer cancel()
	var ok bool
	if err := p.pool.QueryRow(ctx, `SELECT arvc_internal.audio_analysis_settle($1::uuid,$2,$3)`, id, state, nullable(safeCode)).Scan(&ok); err != nil || !ok {
		return ErrUnavailable
	}
	return nil
}

func bounded(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, operationTimeout)
}

func mapResult(result string) error {
	switch result {
	case "disabled":
		return ErrDisabled
	case "not_entitled":
		return ErrNotEntitled
	case "quota_exceeded":
		return ErrQuotaExceeded
	case "concurrency_exceeded":
		return ErrConcurrency
	case "rate_limited":
		return ErrRateLimited
	case "expired":
		return ErrExpired
	case "invalid":
		return ErrInvalid
	default:
		return ErrUnavailable
	}
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

var _ Store = (*Postgres)(nil)
