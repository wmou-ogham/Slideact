//! Maps Google Slides URLs, ids, and one-based page numbers onto cue anchors.

/// Canonical cue value stored for a Google Slides URL, `id.*` token, or page number.
#[must_use]
pub fn normalize_slide_anchor(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(id) = extract_google_slide_id(trimmed) {
        return id;
    }
    trimmed.strip_prefix("id.").unwrap_or(trimmed).to_owned()
}

/// True when a live Google Slides position refers to the same page as a cue anchor.
#[must_use]
pub fn cue_matches_position(
    anchor_value: &str,
    slide_id: Option<&str>,
    slide_index: Option<u32>,
) -> bool {
    let cue_keys = match_keys(anchor_value);
    position_match_keys(slide_id, slide_index)
        .iter()
        .any(|key| cue_keys.iter().any(|cue| cue == key))
}

#[must_use]
pub fn position_match_keys(slide_id: Option<&str>, slide_index: Option<u32>) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(index) = slide_index {
        push_unique(&mut keys, (index + 1).to_string());
    }
    if let Some(slide_id) = slide_id {
        for key in match_keys(slide_id) {
            push_unique(&mut keys, key);
        }
        if slide_index.is_none() && is_first_google_slide(slide_id) {
            push_unique(&mut keys, "1".to_owned());
        }
    }
    keys
}

fn match_keys(value: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let normalized = normalize_slide_anchor(value);
    if !normalized.is_empty() {
        push_unique(&mut keys, normalized);
    }
    let trimmed = value.trim();
    if !trimmed.is_empty() {
        push_unique(&mut keys, trimmed.to_owned());
    }
    keys
}

fn is_first_google_slide(slide_id: &str) -> bool {
    match_keys(slide_id).iter().any(|key| key == "p")
}

fn extract_google_slide_id(value: &str) -> Option<String> {
    let mut last = None;
    let mut remainder = value;
    while let Some(index) = remainder.find("slide=id.") {
        remainder = &remainder[index + "slide=id.".len()..];
        let id: String = remainder
            .chars()
            .take_while(|character| {
                *character != '&' && *character != '#' && !character.is_whitespace()
            })
            .collect();
        if !id.is_empty() {
            last = Some(id);
        }
    }
    last
}

fn push_unique(keys: &mut Vec<String>, value: String) {
    if !value.is_empty() && !keys.iter().any(|existing| existing == &value) {
        keys.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::{cue_matches_position, normalize_slide_anchor, position_match_keys};

    #[test]
    fn extracts_the_final_slide_id_from_a_google_slides_url() {
        assert_eq!(
            normalize_slide_anchor(
                "https://docs.google.com/presentation/d/deck/edit?slide=id.g-old#slide=id.g3f7c2fe3ef4_1_84",
            ),
            "g3f7c2fe3ef4_1_84"
        );
        assert_eq!(
            normalize_slide_anchor("https://docs.google.com/presentation/d/deck/edit#slide=id.p",),
            "p"
        );
        assert_eq!(normalize_slide_anchor("id.gabc"), "gabc");
        assert_eq!(normalize_slide_anchor(" 3 "), "3");
    }

    #[test]
    fn matches_page_numbers_ids_and_the_first_slide_token() {
        assert!(cue_matches_position("5", Some("slide-five"), Some(4)));
        assert!(cue_matches_position(
            "slide-five",
            Some("slide-five"),
            Some(4)
        ));
        assert!(cue_matches_position(
            "https://docs.google.com/presentation/d/deck/edit#slide=id.gabc",
            Some("gabc"),
            None,
        ));
        assert!(cue_matches_position("1", Some("p"), None));
        assert!(cue_matches_position("p", Some("p"), None));
        assert!(!cue_matches_position("2", Some("p"), None));
        assert_eq!(position_match_keys(Some("p"), None), vec!["p", "1"]);
    }
}
