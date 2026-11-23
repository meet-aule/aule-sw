#[test]
fn deeply_nested_blob_origins_do_not_overflow_the_stack() {
    // RUSTSEC-2026-0592: the old recursive implementation aborted the process.
    let nested = format!("{}https://example.test/", "blob:".repeat(10_000));
    let url = reqwest::Url::parse(&nested).unwrap();
    assert_eq!(url.origin().ascii_serialization(), "null");

    let ordinary = reqwest::Url::parse("blob:https://example.test/object").unwrap();
    assert_eq!(ordinary.origin().ascii_serialization(), "https://example.test");
}
