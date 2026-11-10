package stack

import "testing"

func TestParsePS(t *testing.T) {
	nd := `{"Name":"sg-test-api-1","Service":"api","State":"running","Health":"healthy","Image":"sg-api:abc"}
{"Name":"sg-test-db-1","Service":"db","State":"exited","Health":"","Image":"pgvector/pgvector:pg17"}`
	l, err := parsePS(nd)
	if err != nil || len(l) != 2 || l[0].Health != "healthy" || l[1].State != "exited" {
		t.Fatal(l, err)
	}
	l, _ = parsePS(`[{"Service":"web","State":"running"}]`)
	if len(l) != 1 || l[0].Service != "web" {
		t.Error(l)
	}
	if l, _ := parsePS(""); l != nil {
		t.Error(l)
	}
	s := Stack{Project: "sickleguard-test", EnvFile: "e", Files: []string{"a.yml", "b.yml"}}
	if got := s.args("ps"); len(got) != 10 || got[6] != "a.yml" || got[8] != "b.yml" || got[9] != "ps" {
		t.Error(got)
	}
	if s.Volume("db-data") != "sickleguard-test_db-data" {
		t.Error(s.Volume("db-data"))
	}
}
