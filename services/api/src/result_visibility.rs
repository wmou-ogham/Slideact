use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ResultVisibility {
    pub(crate) background_question: bool,
    pub(crate) publish_results: bool,
}

pub(crate) fn result_visibility(settings: &Value) -> ResultVisibility {
    let legacy = legacy_visibility(settings);
    let background_question = result_setting(settings, "background_question")
        .and_then(Value::as_bool)
        .unwrap_or(matches!(legacy, Some("background" | "presenter_only")));
    let publish_results = result_setting(settings, "publish_results")
        .and_then(Value::as_bool)
        .unwrap_or(legacy == Some("live"));
    ResultVisibility {
        background_question,
        publish_results: !background_question && publish_results,
    }
}

pub(crate) fn results_are_public(settings: &Value, cue_state: &str) -> bool {
    let visibility = result_visibility(settings);
    !visibility.background_question && (visibility.publish_results || cue_state == "revealed")
}

fn result_setting<'a>(settings: &'a Value, key: &str) -> Option<&'a Value> {
    settings.get("results")?.get(key)
}

fn legacy_visibility(settings: &Value) -> Option<&str> {
    result_setting(settings, "audience_visibility")?.as_str()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ResultVisibility, result_visibility, results_are_public};

    #[test]
    fn missing_persisted_settings_default_to_not_public() {
        assert_eq!(
            result_visibility(&json!({})),
            ResultVisibility {
                background_question: false,
                publish_results: false,
            }
        );
        assert_eq!(
            result_visibility(&json!({})),
            ResultVisibility {
                background_question: false,
                publish_results: false,
            }
        );
        assert!(!results_are_public(&json!({}), "open"));
        assert!(results_are_public(&json!({}), "revealed"));
    }

    #[test]
    fn background_always_overrides_publication() {
        let settings = json!({
            "results": {"background_question": true, "publish_results": true}
        });
        assert_eq!(
            result_visibility(&settings),
            ResultVisibility {
                background_question: true,
                publish_results: false,
            }
        );
        assert!(!results_are_public(&settings, "revealed"));
    }

    #[test]
    fn unpublished_results_wait_for_reveal_per_interaction() {
        let settings = json!({
            "results": {"background_question": false, "publish_results": false}
        });
        assert!(!results_are_public(&settings, "open"));
        assert!(results_are_public(&settings, "revealed"));
    }

    #[test]
    fn legacy_visibility_values_remain_supported() {
        assert!(results_are_public(
            &json!({"results": {"audience_visibility": "live"}}),
            "open"
        ));
        assert!(!results_are_public(
            &json!({"results": {"audience_visibility": "presenter_only"}}),
            "revealed"
        ));
    }
}
