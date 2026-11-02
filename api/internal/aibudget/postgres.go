package aibudget

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrUnavailable    = errors.New("AI budget store unavailable")
	ErrDisabled       = errors.New("AI generation disabled")
	ErrNotEntitled    = errors.New("AI entitlement required")
	ErrQuotaExceeded  = errors.New("AI quota exceeded")
	ErrConcurrency    = errors.New("AI concurrency limit reached")
	ErrBudgetExceeded = errors.New("AI service budget exceeded")
	ErrDuplicate      = errors.New("idempotency key already used")
	ErrInvalid        = errors.New("AI budget request invalid")
)

type Reservation struct {
	ID              string
	Model           string
	MaxInputTokens  int32
	MaxOutputTokens int32
}

type Settlement struct {
	State        string
	InputTokens  int32
	OutputTokens int32
	ErrorCode    string
}

type Store interface {
	Reserve(context.Context, string, []byte) (Reservation, error)
	Settle(context.Context, string, Settlement) error
	Close()
}

// LocalFixtureStore is available only through the dedicated server-side DB role.
// The HTTP layer must independently gate it by local mode and verified subject.
type LocalFixtureStore interface {
	ReserveLocalFixture(context.Context, string, []byte) (Reservation, error)
}

type Postgres struct{ pool *pgxpool.Pool }

func NewPostgres(ctx context.Context, dsn string) (*Postgres, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, ErrUnavailable
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil || cfg.ConnConfig.User != "arvc_ai_budget" || cfg.ConnConfig.Host != "127.0.0.1" && cfg.ConnConfig.Host != "localhost" && cfg.ConnConfig.Host != "::1" {
		return nil, ErrUnavailable
	}
	cfg.MaxConns = 4
	cfg.MinConns = 0
	p, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, ErrUnavailable
	}
	if err = p.Ping(ctx); err != nil {
		p.Close()
		return nil, ErrUnavailable
	}
	return &Postgres{pool: p}, nil
}

func (p *Postgres) Close() {
	if p != nil && p.pool != nil {
		p.pool.Close()
	}
}

func (p *Postgres) Reserve(ctx context.Context, userID string, idempotencyHash []byte) (Reservation, error) {
	return p.reserveWith(ctx, `arvc_internal.ai_generation_reserve`, userID, idempotencyHash)
}

func (p *Postgres) ReserveLocalFixture(ctx context.Context, userID string, idempotencyHash []byte) (Reservation, error) {
	return p.reserveWith(ctx, `arvc_internal.ai_generation_reserve_local_fixture`, userID, idempotencyHash)
}

func (p *Postgres) reserveWith(ctx context.Context, function, userID string, idempotencyHash []byte) (Reservation, error) {
	if p == nil || p.pool == nil {
		return Reservation{}, ErrUnavailable
	}
	var result string
	var requestID, model pgtype.Text
	var maxInput, maxOutput pgtype.Int4
	query := `SELECT result, request_id::text, model, max_input_tokens, max_output_tokens FROM ` + function + `($1::uuid,$2::bytea)`
	err := p.pool.QueryRow(ctx, query, userID, idempotencyHash).Scan(&result, &requestID, &model, &maxInput, &maxOutput)
	if err != nil {
		return Reservation{}, ErrUnavailable
	}
	switch result {
	case "reserved":
		if !requestID.Valid || !model.Valid || !maxInput.Valid || !maxOutput.Valid {
			return Reservation{}, ErrUnavailable
		}
		return Reservation{ID: requestID.String, Model: model.String, MaxInputTokens: maxInput.Int32, MaxOutputTokens: maxOutput.Int32}, nil
	case "disabled":
		return Reservation{}, ErrDisabled
	case "not_entitled":
		return Reservation{}, ErrNotEntitled
	case "quota_exceeded":
		return Reservation{}, ErrQuotaExceeded
	case "concurrency_exceeded":
		return Reservation{}, ErrConcurrency
	case "budget_exceeded":
		return Reservation{}, ErrBudgetExceeded
	case "duplicate":
		return Reservation{}, ErrDuplicate
	default:
		return Reservation{}, ErrInvalid
	}
}

func (p *Postgres) Settle(ctx context.Context, requestID string, settlement Settlement) error {
	if p == nil || p.pool == nil {
		return ErrUnavailable
	}
	var changed bool
	err := p.pool.QueryRow(ctx, `SELECT arvc_internal.ai_generation_settle($1::uuid,$2,$3,$4,$5)`, requestID, settlement.State, settlement.InputTokens, settlement.OutputTokens, nullable(settlement.ErrorCode)).Scan(&changed)
	if err != nil || !changed {
		return ErrUnavailable
	}
	return nil
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

var _ Store = (*Postgres)(nil)
