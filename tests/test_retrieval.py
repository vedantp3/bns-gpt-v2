"""Retrieval quality checks against the committed statutory_search.db."""

import pytest

import legal_ai


def sections(query: str, act: str = "ALL", previous: str | None = None) -> list[tuple[str, str]]:
    return [(hit[0], hit[1]) for hit in legal_ai.route_and_search(query, act, previous)]


@pytest.mark.parametrize(
    "query, expected_first",
    [
        ("murder", ("BNS", "101")),
        ("What constitutes murder under BNS?", ("BNS", "101")),
        ("punishment for theft", ("BNS", "303")),
        ("dowry death", ("BNS", "80")),
        ("confession to police officer", ("BSA", "23")),
        ("admissibility of electronic records", ("BSA", "63")),
        ("snatching", ("BNS", "304")),
        ("cheating", ("BNS", "318")),
    ],
)
def test_natural_questions_rank_the_right_section_first(query, expected_first):
    assert sections(query)[0] == expected_first


@pytest.mark.parametrize(
    "query, expected",
    [
        ("BNS Section 103", [("BNS", "103")]),
        ("s. 64 bns", [("BNS", "64")]),
        ("sec 35 BNSS", [("BNSS", "35")]),
        ("§ 23 BSA", [("BSA", "23")]),
    ],
)
def test_explicit_section_reference_returns_that_section(query, expected):
    assert sections(query) == expected


def test_bare_number_looks_up_section_in_every_act():
    assert sections("103") == [("BNS", "103"), ("BNSS", "103"), ("BSA", "103")]


def test_numbers_that_are_not_section_references_are_ignored():
    # "7 years" must not turn into a lookup of Section 7.
    assert ("BNS", "7") not in sections("theft punishable with 7 years")
    assert sections("theft punishable with 7 years")[0] == ("BNS", "303")


def test_act_filter_limits_results():
    assert {act for act, _ in sections("arrest", "BNSS")} == {"BNSS"}


def test_follow_up_uses_previous_question():
    assert sections("what is the punishment for that?", previous="What is theft under BNS")[0] == ("BNS", "303")


def test_question_with_only_stopwords_returns_nothing():
    assert sections("what is this under the act?") == []


def test_get_section():
    act, number, title, _, text = legal_ai.get_section("bns", "103")
    assert (act, number, title) == ("BNS", "103", "Punishment for murder")
    assert text
    assert legal_ai.get_section("IPC", "302") is None
    assert legal_ai.get_section("BNS", "99999") is None
