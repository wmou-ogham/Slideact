# Accessibility and bilingual acceptance

## Automated checks

- TypeScript requires Traditional Chinese and English catalogs to implement the same `MessageKey` set.
- The i18n test also compares runtime keys, rejects blank values and verifies identical interpolation parameters.
- Every production Web and Extension build runs under the containerized CI suite.
- Semantic browser snapshots are used to inspect headings, named controls, status regions and dialogs on deployed routes.

## Accessibility behavior

- A keyboard-visible skip link targets the routed main content.
- Every interactive control has visible text or an accessible name.
- Form inputs use associated labels, placeholders with `aria-label`, or contextual names.
- Modal previews use a named `dialog` with `aria-modal` and a named close button.
- Join errors and pairing codes use live status/error semantics.
- A high-visibility `:focus-visible` outline is present throughout the Web UI.
- Animation and transition durations collapse when `prefers-reduced-motion: reduce` is active.
- Layout breakpoints cover desktop, tablet and 320px-wide mobile surfaces.

## Manual acceptance routes

The following routes must be inspected in both `zh-TW` and `en`: landing, presenter authentication, Guest Vault studio, audience join, audience interaction, presenter remote, OBS overlay and diagnostics. Real screen-reader and browser zoom testing remains part of the human beta script; automated semantic inspection does not replace assistive-technology acceptance.
