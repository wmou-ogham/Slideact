# Google Slides Extension

## Install the unpacked extension

1. Run `pnpm --filter @slide-helper/extension build` (the containerized `scripts/ci.sh` also builds it).
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select `apps/extension/.output/chrome-mv3`.
4. Create or select a live session in Slideact, choose **Pair Slides extension**, and enter the eight-character code in the extension popup within ten minutes.
5. Open a Google Slides edit or presentation URL. The first detected deck is bound to that live session.

Pairing codes are single-use. The extension receives a 24-hour extension token and a one-hour overlay token; it never receives the presenter login cookie. Use **Use manual control** at any time to stop automatic position commands without ending the live session.

## Cue mapping

- A cue's slide field accepts a one-based slide number such as `5`.
- The detector sends a zero-based `slideIndex`, so index `4` matches cue slide `5`.
- When Google exposes a stable slide ID, a cue can also map directly to that ID.
- `immediate` cues open automatically in a live session.
- `presenter_confirm` cues are prepared in the `ready` state and wait for the presenter.

## Compatibility matrix

| Surface | Detector source | Expected behavior | Automated coverage | Manual acceptance |
| --- | --- | --- | --- | --- |
| Google Slides editor | active or visible DOM slide, URL fallback | Map current page and report changes | DOM selector, URL and deduplication unit tests | Required before release |
| Google Slides slideshow | visible viewer page, URL fallback | Map page and inject pointer-transparent overlay | Extension build plus content-script contract | Required before release |
| Chrome MV3 116+ | background service worker and alarms | Pair, heartbeat and resume after worker sleep | Type-check, build and API smoke tests | Required before release |
| OBS browser source | independent `/overlay/:session` URL | Transparent realtime results | API/WebSocket smoke test | Verified in presenter workflow |
| PowerPoint, Keynote and other tools | no extension integration | Presenter console or phone remote remains authoritative | Command and state-machine tests | Supported manual fallback |

Google Slides DOM selectors are not a public API and can change. The detector therefore combines active-state attributes, largest visible slide selection, URL parsing, debouncing and a manual fallback. A browser/version row must not be marked manually accepted until it has been exercised against a real deck on that version.

## Diagnostics

The extension sends a heartbeat every 30 seconds. The presenter status considers it disconnected after 70 seconds without a heartbeat. Diagnostics contain only the extension device UUID, deck ID, slide ID/index and the last transport error; they do not contain response data, OAuth credentials or presenter cookies.

## Sync recovery states

- `auto_connected`: position reports can prepare or open mapped cues.
- `auto_paused`: the live session is paused; positions update diagnostics but not cues.
- `manual`: presenter controls remain authoritative and extension positions are ignored.
- `disconnected`: the heartbeat freshness window expired.
- `resync_required`: the extension returned after a disconnect; position commands remain blocked until the presenter confirms auto-follow again.

Switching to manual, disconnecting or waiting for resync never closes, replaces or reopens the current CueRun. This makes auto-to-manual handoff lossless and prevents a recovered browser tab from jumping the audience to a stale slide.
