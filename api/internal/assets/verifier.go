package assets

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
)

const verifierRole = "arvc_asset_verifier"

type PostgresVerifier struct {
	db *sql.DB
}

// NewPostgresVerifier opens the narrowly privileged database connection used
// only for the server-verified ready transition. It never logs the DSN.
func NewPostgresVerifier(dsn string) (*PostgresVerifier, error) {
	if err := validateVerifierDSN(dsn); err != nil {
		return nil, err
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, errors.New("asset verifier database initialization failed")
	}
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(10 * time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, errors.New("asset verifier database connection failed")
	}
	return &PostgresVerifier{db: db}, nil
}

func validateVerifierDSN(dsn string) error {
	parsedURL, err := url.Parse(dsn)
	if err != nil || parsedURL == nil || (parsedURL.Scheme != "postgres" && parsedURL.Scheme != "postgresql") || parsedURL.User == nil || parsedURL.User.Username() != verifierRole || parsedURL.Hostname() == "" || strings.Trim(parsedURL.Path, "/") != "postgres" || parsedURL.RawQuery == "" {
		return errors.New("asset verifier DSN must identify the dedicated database role")
	}
	sslMode := parsedURL.Query().Get("sslmode")
	if isLoopback(parsedURL.Hostname()) {
		if sslMode != "disable" && sslMode != "verify-full" {
			return errors.New("local asset verifier DSN requires sslmode=disable or verify-full")
		}
	} else if sslMode != "verify-full" {
		return errors.New("remote asset verifier DSN requires sslmode=verify-full")
	}
	if _, err := pgx.ParseConfig(dsn); err != nil {
		return errors.New("asset verifier DSN is invalid")
	}
	return nil
}

func (v *PostgresVerifier) MarkReady(ctx context.Context, assetID, ownerID string) (Asset, error) {
	if v == nil || v.db == nil || !uuid(assetID) || !uuid(ownerID) {
		return Asset{}, errors.New("verified asset transition failed")
	}
	var raw []byte
	if err := v.db.QueryRowContext(ctx, "SELECT arvc_internal.project_asset_mark_ready($1::uuid, $2::uuid)", assetID, ownerID).Scan(&raw); err != nil {
		return Asset{}, errors.New("verified asset transition failed")
	}
	var asset Asset
	if json.Unmarshal(raw, &asset) != nil || asset.ID != assetID || asset.OwnerID != ownerID || asset.Status != "ready" || !validObjectKey(asset) {
		return Asset{}, errors.New("verified asset transition returned invalid metadata")
	}
	return asset, nil
}

func (v *PostgresVerifier) Close() error {
	if v == nil || v.db == nil {
		return nil
	}
	return v.db.Close()
}
