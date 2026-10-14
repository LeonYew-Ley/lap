use super::*;

#[test]
fn regional_identifiers_are_valid_for_intl() {
    assert_eq!(normalize_locale_identifier("en_CH"), Some("en-CH".into()));
    assert_eq!(
        normalize_locale_identifier("fr_CH.UTF-8"),
        Some("fr-CH".into())
    );
    assert_eq!(
        normalize_locale_identifier("de_DE@euro"),
        Some("de-DE".into())
    );
    assert_eq!(normalize_locale_identifier("C.UTF-8"), Some("en-US".into()));
    assert_eq!(normalize_locale_identifier("POSIX"), Some("en-US".into()));
    assert_eq!(normalize_locale_identifier(""), None);
}

#[test]
fn linux_uses_time_category_and_ignores_translation_preferences() {
    let get = |key: &str| match key {
        "LANGUAGE" | "LC_MESSAGES" | "LANG" => Some("en_US.UTF-8".into()),
        "LC_TIME" => Some("fr_CH.UTF-8".into()),
        _ => None,
    };
    assert_eq!(time_locale_from_env(get), Some("fr-CH".into()));
    assert_eq!(
        time_locale_from_env(|key| {
            if key == "LC_ALL" {
                Some("de_DE.UTF-8".into())
            } else {
                get(key)
            }
        }),
        Some("de-DE".into())
    );
    assert_eq!(
        time_locale_from_env(|key| {
            if key == "LC_TIME" || key == "LC_ALL" {
                Some(String::new())
            } else {
                get(key)
            }
        }),
        Some("en-US".into())
    );
    assert_eq!(time_locale_from_env(|_| None), None);
}

#[cfg(target_os = "macos")]
#[test]
fn macos_region_matches_current_locale() {
    let identifier = objc2_foundation::NSLocale::currentLocale()
        .localeIdentifier()
        .to_string();
    assert_eq!(
        get_system_region_locale().unwrap(),
        normalize_locale_identifier(&identifier)
    );
    assert!(get_system_region_locale().unwrap().is_some());
}
