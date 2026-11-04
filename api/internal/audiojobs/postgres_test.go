package audiojobs

import (
	"crypto/sha256"
	"testing"
)

func TestHashPayloadMatchesDatabaseCanonicalForm(t *testing.T){
	audio:=[]byte("synthetic wav payload")
	want:=sha256.Sum256([]byte("synthetic wav payload|hard"))
	got:=HashPayload(audio,"hard")
	if string(got)!=string(want[:]){t.Fatalf("job content hash mismatch: got %x want %x",got,want)}
	if string(HashPayload(audio,"soft"))==string(got){t.Fatal("gate mode was omitted from idempotency hash")}
}
