package projects

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"

	"github.com/JunA-priv/audio-reactive-visual-compiler/api/internal/blueprint"
)

const (
	DocumentVersion      = 1
	BlueprintVersion     = 1
	TimelineVersion      = 1
	RendererVersion      = "editor-renderer/1"
	MaxDocumentBytes     = 1 << 20
	MaxRequestBytes      = MaxDocumentBytes + 16<<10
	MaxTimelinePoints    = 50_000
	MaxKickEvents        = 20_000
	MaxProjectTitleRunes = 120
)

type FeaturePoint struct {
	TimeMs float64 `json:"timeMs"`
	Value  float64 `json:"value"`
}

type Timeline struct {
	SchemaVersion           int            `json:"schemaVersion"`
	AnalysisVersion         string         `json:"analysisVersion,omitempty"`
	SampleRateHz            int            `json:"sampleRateHz,omitempty"`
	TimeUnit                string         `json:"timeUnit"`
	DurationMs              int64          `json:"durationMs"`
	BPM                     *float64       `json:"bpm,omitempty"`
	BPMSource               string         `json:"bpmSource,omitempty"`
	BassEnvelope            []FeaturePoint `json:"bassEnvelope"`
	KickEvents              []float64      `json:"kickEvents"`
	KickEventStrengths      []float64      `json:"kickEventStrengths,omitempty"`
	DrumEnergy              []FeaturePoint `json:"drumEnergy,omitempty"`
	SnareEvents             []float64      `json:"snareEvents,omitempty"`
	SnareEventStrengths     []float64      `json:"snareEventStrengths,omitempty"`
	VocalsEnvelope          []FeaturePoint `json:"vocalsEnvelope,omitempty"`
	OtherEnvelope           []FeaturePoint `json:"otherEnvelope,omitempty"`
	MusicEnergy             []FeaturePoint `json:"musicEnergy,omitempty"`
	FeatureHopMs            int            `json:"featureHopMs,omitempty"`
	FeatureSampleRateHz     float64        `json:"featureSampleRateHz,omitempty"`
	Normalization           string         `json:"normalization,omitempty"`
	KickEventStrengthsUnit  string         `json:"kickEventStrengthsUnit,omitempty"`
	SnareEventStrengthsUnit string         `json:"snareEventStrengthsUnit,omitempty"`
}

type Metadata struct {
	BlueprintSchemaVersion       int    `json:"blueprintSchemaVersion"`
	FeatureTimelineSchemaVersion int    `json:"featureTimelineSchemaVersion"`
	RendererVersion              string `json:"rendererVersion"`
	AnalysisVersion              string `json:"analysisVersion"`
	Seed                         int64  `json:"seed"`
}

// Document keeps the existing Editor Blueprint v1 and Feature Timeline v1
// JSON objects intact. It intentionally has no asset fields.
type Document struct {
	DocumentVersion int             `json:"documentVersion"`
	Metadata        Metadata        `json:"metadata"`
	Blueprint       json.RawMessage `json:"blueprint"`
	FeatureTimeline json.RawMessage `json:"featureTimeline"`
}

// CloudEnvelope is a transport/storage wrapper. Its editor blueprint and
// timeline remain v1; image bytes and audio bytes live in Storage assets.
type CloudEnvelope struct {
	CloudDocumentVersion int              `json:"cloudDocumentVersion"`
	Metadata             Metadata         `json:"metadata"`
	EditorState          CloudEditorState `json:"editorState"`
	FeatureTimeline      json.RawMessage  `json:"featureTimeline"`
	AssetRefs            CloudAssetRefs   `json:"assetRefs"`
}

type CloudEditorState struct {
	Blueprint         json.RawMessage `json:"blueprint"`
	BackgroundAssetID *string         `json:"backgroundAssetId"`
}

type CloudAssetRefs struct {
	AudioAssetID *string `json:"audioAssetId"`
}

type CreateRequest struct {
	Title    string          `json:"title"`
	Document json.RawMessage `json:"document"`
}

type UpdateRequest struct {
	Title    string          `json:"title"`
	Revision int64           `json:"revision"`
	Document json.RawMessage `json:"document"`
}

type storedDocument struct {
	Document Document
	Cloud    *CloudEnvelope
	Raw      json.RawMessage
}

func DecodeStoredDocument(raw []byte) (storedDocument, error) {
	if len(raw) > 0 && len(raw) <= MaxDocumentBytes {
		var header struct {
			CloudDocumentVersion *int `json:"cloudDocumentVersion"`
		}
		if json.Unmarshal(raw, &header) == nil && header.CloudDocumentVersion != nil {
			return DecodeCloudEnvelope(raw)
		}
	}
	return DecodeDocument(raw)
}

func DecodeCloudEnvelope(raw []byte) (storedDocument, error) {
	if len(raw) == 0 || len(raw) > MaxDocumentBytes {
		return storedDocument{}, errors.New("cloud document must be between 1 byte and 1 MiB")
	}
	var envelope CloudEnvelope
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if decoder.Decode(&envelope) != nil {
		return storedDocument{}, errors.New("invalid cloud document envelope")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return storedDocument{}, errors.New("cloud envelope must contain exactly one JSON value")
	}
	if envelope.CloudDocumentVersion != 1 || envelope.Metadata.BlueprintSchemaVersion != BlueprintVersion || envelope.Metadata.FeatureTimelineSchemaVersion != TimelineVersion || envelope.Metadata.RendererVersion != RendererVersion || len(envelope.Metadata.AnalysisVersion) > 256 {
		return storedDocument{}, errors.New("unsupported cloud, Blueprint, Feature Timeline, or renderer version")
	}
	blueprintValue, err := blueprint.Decode(envelope.EditorState.Blueprint)
	if err != nil {
		return storedDocument{}, errors.New("cloud editor Blueprint does not match v1")
	}
	seed, seedErr := blueprintValue.Seed.Int64()
	if seedErr != nil || seed != envelope.Metadata.Seed {
		return storedDocument{}, errors.New("cloud project seed does not match Blueprint")
	}
	var bg struct {
		Kind  string `json:"kind"`
		Color string `json:"color"`
	}
	if json.Unmarshal(blueprintValue.Background, &bg) != nil || (bg.Kind != "solid" && bg.Kind != "gradient") {
		return storedDocument{}, errors.New("cloud envelope must not embed a data URL background")
	}
	if envelope.EditorState.BackgroundAssetID != nil {
		if !idPattern.MatchString(*envelope.EditorState.BackgroundAssetID) || bg.Kind != "solid" || !strings.EqualFold(bg.Color, "#000000") {
			return storedDocument{}, errors.New("image asset reference requires the canonical solid placeholder")
		}
	}
	if envelope.AssetRefs.AudioAssetID != nil && !idPattern.MatchString(*envelope.AssetRefs.AudioAssetID) {
		return storedDocument{}, errors.New("invalid audio asset reference")
	}
	var timeline Timeline
	timelineDecoder := json.NewDecoder(bytes.NewReader(envelope.FeatureTimeline))
	timelineDecoder.DisallowUnknownFields()
	if timelineDecoder.Decode(&timeline) != nil || timelineDecoder.Decode(&extra) != io.EOF {
		return storedDocument{}, errors.New("cloud Feature Timeline does not match v1")
	}
	if err := validateTimeline(timeline); err != nil {
		return storedDocument{}, err
	}
	if envelope.Metadata.AnalysisVersion != "unknown" && timeline.AnalysisVersion != "" && envelope.Metadata.AnalysisVersion != timeline.AnalysisVersion {
		return storedDocument{}, errors.New("analysis version does not match Feature Timeline")
	}
	return storedDocument{Cloud: &envelope, Raw: append(json.RawMessage(nil), raw...)}, nil
}

func CloudAssetReferences(raw []byte) (backgroundID, audioID string, cloud bool, err error) {
	document, err := DecodeStoredDocument(raw)
	if err != nil {
		return "", "", false, err
	}
	if document.Cloud == nil {
		return "", "", false, nil
	}
	if document.Cloud.EditorState.BackgroundAssetID != nil {
		backgroundID = *document.Cloud.EditorState.BackgroundAssetID
	}
	if document.Cloud.AssetRefs.AudioAssetID != nil {
		audioID = *document.Cloud.AssetRefs.AudioAssetID
	}
	return backgroundID, audioID, true, nil
}

func DecodeDocument(raw []byte) (storedDocument, error) {
	if len(raw) == 0 || len(raw) > MaxDocumentBytes {
		return storedDocument{}, errors.New("document must be between 1 byte and 1 MiB")
	}
	var document Document
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(&document); err != nil {
		return storedDocument{}, errors.New("invalid project document")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return storedDocument{}, errors.New("project document must contain exactly one JSON value")
	}
	if document.DocumentVersion != DocumentVersion {
		return storedDocument{}, errors.New("unsupported project document version")
	}
	metadata := document.Metadata
	if metadata.BlueprintSchemaVersion != BlueprintVersion || metadata.FeatureTimelineSchemaVersion != TimelineVersion {
		return storedDocument{}, errors.New("unsupported Blueprint or Feature Timeline version")
	}
	if metadata.RendererVersion != RendererVersion || len(metadata.AnalysisVersion) > 256 {
		return storedDocument{}, errors.New("unsupported renderer or invalid analysis version")
	}
	blueprintValue, err := blueprint.Decode(document.Blueprint)
	if err != nil {
		return storedDocument{}, errors.New("Blueprint does not match Editor schema v1")
	}
	seed, seedErr := blueprintValue.Seed.Int64()
	if seedErr != nil || seed != metadata.Seed {
		return storedDocument{}, errors.New("project seed does not match Blueprint")
	}
	var timeline Timeline
	timelineDecoder := json.NewDecoder(bytes.NewReader(document.FeatureTimeline))
	timelineDecoder.DisallowUnknownFields()
	if err := timelineDecoder.Decode(&timeline); err != nil {
		return storedDocument{}, errors.New("Feature Timeline does not match schema v1")
	}
	if err := timelineDecoder.Decode(&extra); err != io.EOF {
		return storedDocument{}, errors.New("Feature Timeline must contain exactly one JSON value")
	}
	if err := validateTimeline(timeline); err != nil {
		return storedDocument{}, err
	}
	if metadata.AnalysisVersion != "unknown" && timeline.AnalysisVersion != "" && metadata.AnalysisVersion != timeline.AnalysisVersion {
		return storedDocument{}, errors.New("analysis version does not match Feature Timeline")
	}
	return storedDocument{Document: document, Raw: append(json.RawMessage(nil), raw...)}, nil
}

func validateTimeline(t Timeline) error {
	if t.SchemaVersion != TimelineVersion || t.TimeUnit != "ms" || t.DurationMs < 1 || t.DurationMs > 24*60*60*1000 {
		return errors.New("unsupported or invalid Feature Timeline v1")
	}
	if len(t.AnalysisVersion) > 256 || t.SampleRateHz < 0 || t.SampleRateHz > 384_000 || t.FeatureHopMs < 0 || t.FeatureHopMs > 1000 || !finite(t.FeatureSampleRateHz) || t.FeatureSampleRateHz < 0 || t.FeatureSampleRateHz > 1000 || len(t.Normalization) > 256 || len(t.KickEventStrengthsUnit) > 128 || len(t.SnareEventStrengthsUnit) > 256 {
		return errors.New("invalid Feature Timeline metadata")
	}
	if (t.BPM == nil) != (t.BPMSource == "") || (t.BPM != nil && (!finite(*t.BPM) || *t.BPM < 40 || *t.BPM > 240 || (t.BPMSource != "kick-estimated" && t.BPMSource != "fallback") || (t.BPMSource == "fallback" && *t.BPM != 120) || (t.BPMSource == "kick-estimated" && (*t.BPM < 60 || *t.BPM > 180)))) {
		return errors.New("invalid Feature Timeline BPM metadata")
	}
	if len(t.BassEnvelope) == 0 || len(t.BassEnvelope) > MaxTimelinePoints || len(t.DrumEnergy) > MaxTimelinePoints || len(t.VocalsEnvelope) > MaxTimelinePoints || len(t.OtherEnvelope) > MaxTimelinePoints || len(t.MusicEnergy) > MaxTimelinePoints || len(t.KickEvents) > MaxKickEvents || len(t.SnareEvents) > MaxKickEvents || (t.KickEventStrengths != nil && len(t.KickEventStrengths) != len(t.KickEvents)) || ((t.SnareEvents == nil) != (t.SnareEventStrengths == nil)) || (t.SnareEventStrengths != nil && len(t.SnareEventStrengths) != len(t.SnareEvents)) {
		return errors.New("Feature Timeline item limit or kick strength alignment exceeded")
	}
	if err := validatePoints(t.BassEnvelope, t.DurationMs); err != nil {
		return fmt.Errorf("invalid bassEnvelope: %w", err)
	}
	if t.DrumEnergy != nil {
		if err := validatePoints(t.DrumEnergy, t.DurationMs); err != nil {
			return fmt.Errorf("invalid drumEnergy: %w", err)
		}
	}
	for _, item := range []struct {
		name   string
		points []FeaturePoint
	}{{"vocalsEnvelope", t.VocalsEnvelope}, {"otherEnvelope", t.OtherEnvelope}, {"musicEnergy", t.MusicEnergy}} {
		if item.points != nil {
			if len(item.points) == 0 {
				return fmt.Errorf("%s must not be empty when present", item.name)
			}
			if err := validatePoints(item.points, t.DurationMs); err != nil {
				return fmt.Errorf("invalid %s: %w", item.name, err)
			}
		}
	}
	previous := -1.0
	for _, event := range t.KickEvents {
		if !finite(event) || event < 0 || event > float64(t.DurationMs) || event <= previous {
			return errors.New("kickEvents must be finite, sorted, and within duration")
		}
		previous = event
	}
	for _, strength := range t.KickEventStrengths {
		if !finite(strength) || strength < 0 || strength > 1 {
			return errors.New("kickEventStrengths must be normalized to 0..1")
		}
	}
	previous = -1
	for i, event := range t.SnareEvents {
		if !finite(event) || event < 0 || event > float64(t.DurationMs) || event <= previous || !finite(t.SnareEventStrengths[i]) || t.SnareEventStrengths[i] < 0 || t.SnareEventStrengths[i] > 1 {
			return errors.New("snare events and strengths must be aligned, normalized, sorted, and within duration")
		}
		previous = event
	}
	return nil
}

func validatePoints(points []FeaturePoint, duration int64) error {
	previous := -1.0
	for _, point := range points {
		if !finite(point.TimeMs) || !finite(point.Value) || point.TimeMs < 0 || point.TimeMs > float64(duration) || point.TimeMs <= previous || point.Value < 0 || point.Value > 1 {
			return errors.New("points must be finite, sorted, within duration, and normalized")
		}
		previous = point.TimeMs
	}
	return nil
}

func ValidateTitle(title string) error {
	trimmed := strings.TrimSpace(title)
	if trimmed == "" || len([]rune(trimmed)) > MaxProjectTitleRunes {
		return errors.New("title must contain 1..120 characters")
	}
	return nil
}

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }
