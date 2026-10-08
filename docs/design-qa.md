# Design QA — 模型能力调度

- source visual truth path: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-4f5d6f5c-d252-41bb-a6bc-3e5c909bc41b.png`
- implementation screenshot path: not captured
- viewport: target reference 1240 × 700; implementation viewport unavailable
- state: light theme, “视觉理解” selected, populated model priority list

**Full-view comparison evidence**

The source screenshot is available and was used to implement the header summary, action order, two-column capability workspace, selected capability card, model priority list, direct-call switch, and strategy preview. A rendered implementation screenshot was not captured, so a same-state side-by-side comparison could not be completed.

**Focused region comparison evidence**

Not available. The implementation was not relaunched after the user reported unwanted lingering Electron processes. Static code and interaction checks do not replace rendered visual evidence.

**Findings**

- [P2] Rendered fidelity remains unverified.
  - Location: model capability routing settings screen.
  - Evidence: source screenshot exists, but no implementation screenshot exists at the same viewport and state.
  - Impact: exact spacing, text wrapping, icon treatment, and light/dark theme contrast cannot be certified visually.
  - Fix: open one user-controlled development instance, capture the routing page in the matching state, compare it with the source, and correct any visible drift.

**Required fidelity surfaces**

- Fonts and typography: implemented with existing application font tokens; rendered weight and wrapping not visually verified.
- Spacing and layout rhythm: reference proportions encoded in responsive CSS; rendered alignment not visually verified.
- Colors and visual tokens: all new surfaces use existing theme variables and `color-mix`; light/dark output not visually verified.
- Image quality and asset fidelity: the existing Lingxi brand image is used for the title icon; rendered sharpness and crop not visually verified.
- Copy and content: source hierarchy and Chinese labels are implemented; runtime model names and counts remain data-driven.

**Comparison history**

- Iteration 1: implemented the reference structure and passed syntax/static interaction regressions. No browser-rendered comparison was performed, so no visual fixes can be claimed.

**Implementation checklist**

- Capture the screen at 1240 × 700 in light theme.
- Verify capability switching, direct-call toggle, drag ordering, save, and reset.
- Capture dark theme and a narrow responsive state.
- Compare the source and implementation in one visual input, then fix any P0/P1/P2 differences.

final result: blocked

## AI 权限模式 — 2026-07-22

- source visual truth path: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-e288f438-5544-41e8-b5a8-fb56fda2a5ee.png`
- implementation screenshot path: not captured
- target viewport: 1234 × 698, dark theme, complete authorization selected

Implemented: header hierarchy, three permission mode cards, live status summary, searchable authorization list, add/revoke actions, responsive layout, and theme-token surfaces. Existing mode, smart-model, search, add, and remove logic remains bound to the original IDs.

Visual comparison is not captured because the development app was intentionally not relaunched after the user reported lingering Electron processes. Static checks passed: `node --check frontend/scripts/features/ai-permission-settings.js`, `frontend.modular-init`, and `git diff --check`.

final result: blocked

## 手机端远程工作台 — 2026-07-22

- source visual truth path: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-a6e0ae46-3491-4e8a-82df-ac8136af71c6.png`
- real-device evidence path: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-6b237be6-81f1-4557-a874-f32ef8f56104.jpg`
- implementation screenshot path: `E:/灵犀-11/新版本/01/灵犀-05/output/mobile-dashboard-preview.png`
- combined comparison path: `E:/灵犀-11/新版本/01/灵犀-05/output/mobile-dashboard-comparison-final.png`
- source pixels: 378 × 659
- implementation pixels: 378 × 659
- CSS viewport: 378 × 659; device scale factor: 1
- density normalization: none; both images were compared at native 1:1 dimensions
- state: dark theme, populated dashboard, first model active, home tab selected

**Full-view comparison evidence**

The source and rendered implementation were placed side by side in one 756 × 659 comparison image. Header, search/new row, three current-task rows, two-column information cards, and the five-item fixed navigation align to the same compact mobile hierarchy. Product branding intentionally uses “灵犀” instead of the reference product name while preserving the source type scale and placement.

**Focused region comparison evidence**

A separate crop was not needed because both 378px-wide views remain at 1:1 scale in the combined image. Header controls, progress rows, card copy, status dots, model label, and bottom navigation are readable in the full comparison and were checked directly.

**Comparison history**

- Iteration 1 found a P2 vertical-rhythm mismatch: the task area was about 20px shorter than the reference and the second dashboard row ran beneath the fixed navigation. The task rows were raised to 54px, the task card to 162px, compact list rows were reduced to 31px, and the lower cards were constrained to the reference-height footprint.
- Iteration 2 shows the dashboard grid beginning and ending within a few pixels of the source, with the entire lower card row visible above the navigation. No actionable P0/P1/P2 visual differences remain.
- The real-device capture exposed a P1 data-state problem: the bridge returned only in-memory active projects, causing all three data regions to appear empty. The remote project command now merges saved, non-archived projects with active instances and activates a saved project on selection. Empty-state cards were also reduced so a genuinely empty workspace no longer produces oversized blank regions.

**Required fidelity surfaces**

- Fonts and typography: Chinese system-font hierarchy matches the source’s compact weights, truncation, and line heights; brand text is intentionally localized.
- Spacing and layout rhythm: outer insets, 7px card gaps, 162px task area, compact two-column cards, safe-area-aware fixed navigation, and 378px viewport composition were verified.
- Colors and visual tokens: near-black navy surfaces, cyan primary actions, teal success, amber warnings, muted borders, and restrained shadows match the source and are centralized in mobile tokens.
- Image quality and asset fidelity: the source contains no required product photography; existing application SVG icon assets remain sharp at mobile density. The optional source header decoration was omitted to preserve the Lingxi brand rather than approximating it.
- Copy and content: reference information architecture is preserved with Lingxi-specific Chinese labels and real project/model/runtime data.

**Primary interactions tested**

- Search filters tasks and dashboard cards (`order` retained `order-service` and removed unrelated projects).
- New task opens the active project chat and focuses the message field; back returns to home.
- Settings opens the settings page; back returns home.
- Project navigation focuses the project region; Files provides visible toast feedback.
- Browser console errors and warnings: none.
- JavaScript syntax, command-router project merge/switch unit check, and `git diff --check`: passed.

**Data integrity correction**

- The visual-only `?preview=1` fixture and all hard-coded task percentages, ETAs, project stacks, model names, and timestamps were removed from the production web client.
- Current tasks now come from desktop-active projects plus their real durable `task-runs` state.
- Recent conversations now come from persisted run journals (`messagePreview`, `modelName` / `modelId`, `updatedAt`).
- Active projects now use the real in-memory active flag, branch name, and history count.
- Saved inactive projects are still listed by the bridge, but are not mislabeled as active; selecting one activates its real project instance.
- Missing values render as honest empty states or `--`; there are no synthetic fallback values.
- The earlier comparison screenshots remain layout-only evidence and must not be treated as runtime-data evidence.

final result: passed

## 新增模型弹窗 — 2026-07-22

- source visual truth: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-fe0f2738-2ba0-4a28-8229-f482a8f7c7df.png`
- implementation route: `http://127.0.0.1:4173/index.html`
- verified states: light theme and classic dark theme
- verified viewports: 1295 × 921, 760 × 760, 480 × 760

**Full-view comparison evidence**

The source and the rendered implementation were inspected together in one comparison input. The implementation preserves the source hierarchy and grouping: title/subtitle header, basic information card, connection card, capability/preview split card, security note, and paired footer actions. At desktop size the modal expands from the small reference to a 720px-wide working surface while retaining the same proportions and visual rhythm. Dark-theme tokens closely match the source; light-theme rendering correctly follows the active application theme.

**Responsive and interaction checks**

- 1295 × 921: 720px dialog, all cards and footer visible without page overflow.
- 760 × 760: dialog fits within a 9px viewport inset and uses an internal body scrollbar.
- 480 × 760: dialog width is 458px; capability/preview content stacks to one column and footer actions stack without horizontal clipping.
- Cancel closes the modal and the add-model trigger reopens it.
- Test connection produces inline validation feedback when required fields are missing.
- Full URL mode replaces automatic routes with `使用完整 URL` in the connection preview.
- API URL/model edits update the preview; API key, URL lock, key visibility, and capability selections retain their existing functional controls.

**Required fidelity surfaces**

- Fonts and typography: responsive `clamp()` sizes maintain the source hierarchy without copying its small screenshot scale literally.
- Spacing and layout rhythm: section gaps, card padding, labels, hints, inputs, and footer spacing match the source structure at an adaptive desktop scale.
- Colors and visual tokens: all surfaces use application theme variables; light and dark themes were both rendered and inspected.
- Copy and content: all labels, hints, routes, capability names, security note, and actions match the requested model-connection flow.
- Core interactions: cancel, add/save, capability selection, API-key visibility, lock controls, URL mode, live route preview, validation, and real IPC-backed connection testing are wired.

final result: passed

## AI 安全快照侧栏 — 2026-07-22

- source visual truth path: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-ab7e52ac-1ba2-43d3-8543-09cdca33452d.png`
- previous implementation evidence: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-aa7e1d07-467d-454a-a2b6-5feee975cfa9.png`
- verified state: dark theme, recovery history selected, counts 0 / 1582

**Comparison result**

- Replaced the icon-only orange Git header with the cyan shield identity and visible “AI 安全快照” title.
- Matched the reference navigation order, compact vertical rhythm, narrow rail width, cyan history selection, muted inactive icons, and pill counters.
- Removed the desktop back arrow from the branded rail; it remains available when the layout collapses to the narrow-window top header.
- Sidebar colors continue to derive from the active theme tokens, so the same structure adapts to non-dark themes.
- The reference and rendered implementation were compared together at the selected recovery-history state; no clipping or missing navigation items remain.

final result: passed

## 恢复点历史工作台 — 2026-07-22

- source visual truth path: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-c2aeb894-9f6c-4f40-9a37-cddb60141f71.png`
- source size: 804 × 691
- verified implementation viewport: 1047 × 878（与 1295 × 921 桌面窗口扣除应用侧栏后的内容区接近）
- state: dark theme, populated history, first file recovery point selected and expanded

**Full-view comparison evidence**

The source and implementation were rendered together in one comparison pass. The implementation preserves the source hierarchy and proportions while scaling the small reference to the real desktop content area: title/refresh, four summary cards, search and four filters, create action, grouped timeline, expanded change preview, right-side detail, and fixed pagination are all visible without clipping.

**Responsive verification**

- 1047 × 878: two-column timeline/detail workspace, four summary cards, all filters, visible pagination.
- 760 × 878: two-column summary cards, wrapped toolbar, full-width primary action, timeline first and detail stacked below.
- The history panel owns internal scrolling at desktop size; narrow layouts switch to page scrolling so content is not compressed into unreadable cards.

**Interaction coverage**

- Search, type/time/sort filters, clickable summary filters, pagination, and page-size selection are connected to the unified history dataset.
- Timeline selection, expand/collapse preview, detail synchronization, file preview, Git diff, restore, safe delete, refresh, and create-navigation are connected to the existing application APIs.
- File-level and Git-level data are loaded together and grouped by today/yesterday/earlier.

**Findings resolved**

- [P1] The old history view was only a generic stacked list and did not match the supplied management dashboard. Replaced with the full timeline/detail workspace.
- [P1] Pagination initially overflowed below the timeline panel because the empty notices node changed implicit grid placement. Fixed with explicit grid-row placement for notices, list, and footer.
- [P2] The project filter was hidden at the real desktop content width. Kept all reference filters visible and allowed only narrower breakpoints to wrap the toolbar.
- [P2] The small source typography was not copied literally; type, cards, and controls use container-aware scaling for the actual Electron workspace.

final result: passed

## 待快照改动工作台 — 2026-07-22

- source visual truth path: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-11c1ab21-60c4-4886-9f8b-d8c686ec525b.png`
- runtime evidence before density fix: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-a96d9b61-49c3-4103-9043-41b4e419803f.png`
- focused runtime evidence before interaction fix: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-7f537334-325c-4756-9a94-845575e65ff0.png`, `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-b287030f-32fe-4ee1-b288-efb200375f92.png`
- implementation screenshot path: in-app Browser capture of `http://127.0.0.1:4173/_qa-git-changes.html`
- source pixels: 772 × 692
- implementation CSS viewport and pixels: 1047 × 878 at 1×; responsive check at 700 × 900
- density normalization: the source is a compact design reference; layout proportions were preserved while typography, row height, controls, and cards were scaled for the actual 1295 × 921 Electron window.
- state: dark theme, populated Git changes, one selected file, total filter active

**Comparison history**

- Iteration 1 found a P1 density mismatch in the real Electron capture: most supporting text rendered at 9–10px and the page read as a miniaturized copy. Fixed by increasing the type hierarchy to 12–14px, raising control and row heights, enlarging summary cards and the right overview, and separating refresh from the filter row.
- Iteration 2 found a P2 interaction/affordance gap: the four summary cards were static, and native select focus inherited a conspicuous green rectangular ring. Fixed by converting summary cards into keyboard-accessible filter buttons with active states and by replacing the select ring with a theme-token border focus state.
- Post-fix desktop capture shows the intended two-column list/overview structure with larger readable copy. The 700px capture stacks the overview below the list without overlap or horizontal clipping.

**Required fidelity surfaces**

- Fonts and typography: hierarchy is enlarged for the actual desktop workspace; title, stats, row labels, metadata, controls, and help copy remain visibly distinct.
- Spacing and layout rhythm: reference composition is preserved; summary cards, action strip, table rows, pagination, overview, and help panel use adaptive spacing and container-query breakpoints.
- Colors and visual tokens: all production surfaces follow existing theme variables; active filters use their semantic card color and select focus uses the application accent token.
- Image quality and asset fidelity: the source contains no raster imagery; the UI uses the application's existing icon treatment and a data-driven overview chart.
- Copy and content: reference labels and task hierarchy are preserved; counts, file paths, timestamps, statuses, directories, and pagination are data-driven.

**Interaction checks**

- Search, file type, directory, sort, page size, select-all, per-file selection, pagination, refresh, and navigation to create a recovery point are bound.
- Summary cards filter all, unstaged, configuration, or project files and expose `aria-pressed` state.
- Stage and ignore operations use validated project-relative paths; ignore keeps local files and uses a custom confirmation dialog.
- JavaScript syntax, Electron preload syntax, Git backend syntax, CSS compilation, read-only Git status integration, and diff whitespace checks passed.

final result: passed

## AI 安全快照中心 — 2026-07-22

- source visual truth path: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-d644f59c-2b0c-4b3d-bbf1-fc0ba04c850e.png`
- implementation evidence: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-76b232bf-715d-4e77-8362-4f56e8699ad6.png`, `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-f2576257-3f31-4730-9f7b-3b2ba2279357.png`, `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-2c1e0b4d-6d24-43a7-9daa-640ea98e0051.png`
- revised implementation screenshot path: not captured
- state: dark theme, populated Git status and branch data

**Implemented and corrected**

- Rebuilt the snapshot overview with the reference hierarchy: navigation rail, safety hero, live metrics, branch summary, storage progress, and four-step safety flow.
- Added a responsive assurance section below the four-step flow to use tall-window space without stretching the core cards.
- Increased the safety-flow helper copy from the overly small auxiliary size to an adaptive 11–13px range.
- Fixed the branch-management clipping shown in the latest implementation evidence. The independent branch panel now restores its own non-absolute header and two-column body instead of inheriting the overview navigation rail geometry.
- At a container width of 860px or below, branch management switches to a stacked layout.

**Checks**

- CSS compilation passed.
- JavaScript syntax passed.
- `git diff --check` passed except for existing line-ending notices.
- Post-fix visual comparison is blocked because Windows Graphics Capture returned `0x80004002` twice for the Electron window. No further app input was attempted.

final result: blocked

## Skill 资源中心自适应修正 — 2026-07-22

- source visual truth path: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-aea75e4f-fb20-488a-b7c9-c76658fc2597.png`
- implementation evidence before fix: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-ab718f11-4502-4eb6-8689-ba7a348b8090.png`
- revised implementation screenshot path: not captured
- implementation viewport: 1295 × 918 window; resource-center content region is approximately 1000px wide after the application sidebar
- state: dark theme, Skill tab, first Skill selected

**Full-view comparison evidence**

The implementation evidence exposed a P1 responsive-density mismatch: the viewport media query used the full 1295px window and retained four columns even though the actual resource-center container was only about 1000px wide. This compressed each card to roughly 164px and reduced card typography to 9–10px. The fix changes the breakpoint source from viewport width to the Skill container width. At this captured size the main area now uses three wider columns, 12 items per page, 11–12px card copy, larger icons and controls, while wider containers retain four columns and narrow containers step down to two or one.

**Focused region comparison evidence**

- Card grid: switched from viewport media queries to named CSS container queries.
- Pagination: page size now follows the same container breakpoints as the visual grid and updates through `ResizeObserver` when the window is resized.
- Detail pane: its width now scales from the Skill container with `cqw`, not from the whole application viewport.
- Typography and controls: card titles, descriptions, metadata, status labels, filters, buttons, and detail text are enlarged at the approximately 1000px container breakpoint.

**Findings**

- [P2] Revised responsive rendering still needs a post-fix screenshot.
  - Location: Skill resource-center screen.
  - Evidence: the user-provided pre-fix capture is available, but no revised capture exists at the same 1295 × 918 state.
  - Impact: exact post-fix wrapping and bottom pagination position cannot be visually certified.
  - Fix: refresh the Electron renderer, reopen Skill, capture the same window size, and compare the three-column result with the target.

**Required fidelity surfaces**

- Fonts and typography: increased to readable 10–16px ranges by hierarchy; post-fix rendering not captured.
- Spacing and layout rhythm: container-aware 3/4/2/1-column layout with synchronized page size; post-fix rendering not captured.
- Colors and visual tokens: unchanged and fully driven by the resource-center light/dark theme variables.
- Image quality and asset fidelity: no raster imagery is required; the existing application icon system is reused.
- Copy and content: all labels remain data-driven and match the Skill management hierarchy.

**Comparison history**

- Iteration 1: forced four columns based on full viewport width; user evidence showed compressed cards and typography.
- Iteration 2: replaced viewport breakpoints with container queries, switched the captured size to three columns, synchronized 12-item pagination, and enlarged hierarchy text and controls.
- Post-fix visual evidence: unavailable.

final result: blocked

## MCP 资源中心 — 2026-07-22

- source visual truth path: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-ed2f2b68-2556-4340-bae1-411f31faa6ce.png`
- implementation screenshot path: revised implementation not captured
- target pixels: 923 × 649
- previous implementation evidence: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-022cfa3a-ac42-41cb-ab8d-1353538fa292.png` at 1295 × 918
- intended CSS viewport: existing Electron workspace, responsive desktop layout
- density normalization: source proportions are scaled with `clamp()` rather than copied as fixed pixels
- state: dark theme, MCP tab, first server selected, populated detail panel

**Full-view comparison evidence**

The previous implementation capture showed a P1 scale mismatch: 8–11px typography, 110px cards, and a 228px details column copied the small reference too literally into a substantially larger workspace. The revised implementation replaces those fixed dimensions with viewport-aware `clamp()` sizing, moves the six-item summary row across the full width, and lets the card/detail workspace consume the remaining height. A post-fix Electron capture could not be produced because Windows Graphics Capture returned `0x80004002` for this Electron window and the active app was no longer on the MCP tab.

**Focused region comparison evidence**

- Header summary: revised to five data cards plus the primary “新增 MCP” action from the latest source.
- Filter and view toolbar: revised to include all/enabled/disabled/local/remote/official/community filters, sort, and labeled grid/list controls.
- MCP card: revised with larger adaptive icon/type, status, overflow action, metadata, three utility icons, and functional enable switch.
- Detail panel: revised to start below the summary row, fill the remaining workspace height, and scale typography, configuration code, connection data, and footer actions.
- Revised rendered crops are unavailable, so exact post-fix wrapping and vertical rhythm remain unverified.

**Findings**

- [P2] Post-fix rendered fidelity is not visually verified.
  - Location: MCP resource-center screen.
  - Evidence: the latest target and previous implementation are available, but no revised implementation screenshot exists at the same state.
  - Impact: exact responsive scale, card wrapping, and right-panel footer position cannot be certified.
  - Fix: refresh the Electron renderer, reopen MCP, capture the 1295 × 918 workspace, and compare it with the 923 × 649 target after proportional normalization.

**Required fidelity surfaces**

- Fonts and typography: moved to responsive 10–22px ranges by hierarchy; revised rendering not captured.
- Spacing and layout rhythm: summary spans six columns; lower area is a flexible main/detail grid; cards and controls scale with viewport; revised rendering not captured.
- Colors and visual tokens: all new styling uses the resource-center theme variables and semantic state colors.
- Image quality and asset fidelity: no raster imagery is required; MCP/service icons reuse the app’s existing icon system.
- Copy and content: target labels and hierarchy are implemented; counts, names, descriptions, commands, and capabilities remain driven by real MCP data.

**Comparison history**

- Iteration 1: recreated the smaller reference with fixed compact values; user evidence identified a P1 scale mismatch.
- Iteration 2: converted the interface to adaptive sizing and changed the layout to the newer 923 × 649 reference, including the add action and expanded filter/card controls.
- Post-fix evidence: blocked by Electron window capture failure and unavailable matching runtime state.

**Implementation checklist**

- Refresh the current Electron renderer and reopen the MCP tab.
- Verify add, filters, sort, grid/list switch, selection, enable switch, config copy, and edit configuration.
- Capture the revised desktop state and compare it against the latest source.
- Correct any remaining P0/P1/P2 visual mismatch before declaring final fidelity.

final result: blocked

## Skill / MCP 工具栏与列表模式修正 — 2026-07-22

- source visual truth path: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-aea75e4f-fb20-488a-b7c9-c76658fc2597.png`
- implementation evidence before fix: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-0dd01924-9c30-41e7-9e3e-342d88cec2da.png`
- focused evidence: `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-8de1f783-33b0-4055-9f3f-35b4ac944087.png`, `C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-40bf41cf-5e09-4723-ae44-fbe6040bfecd.png`
- revised implementation screenshot path: not captured
- state: dark theme, Skill tab, list view

**Findings and fixes**

- [P1] List-card description was vertically clipped into isolated glyph fragments. Fixed by replacing the two-column compressed card layout with one-column horizontal rows and a stable single-line description track.
- [P2] Sort caret sat below the text baseline. Fixed by replacing the text glyph with the existing SVG icon treatment and explicit flex centering.
- [P2] MCP sort used separate text arrows with the same baseline drift. Fixed with centered SVG sort and chevron icons using the same control treatment.
- [P2] Skill search was missing while MCP search remained visible. Fixed by exposing the shared resource-center search field on the Skill tab and filtering name, title, description, content, author, and source.

**Required fidelity surfaces**

- Fonts and typography: list descriptions now use a complete 18px line box; sort label and icon share one centered flex line.
- Spacing and layout rhythm: list mode now uses a single horizontal row per Skill with dedicated head, description, metadata, and action tracks.
- Colors and visual tokens: unchanged; controls continue using resource-center theme variables.
- Image quality and asset fidelity: no raster assets are involved; existing app icons are reused.
- Copy and content: search placeholder is `搜索 Skill 名称、能力或来源...`; live results retain existing Skill data.

Post-fix visual capture is unavailable, so exact runtime alignment remains unverified.

final result: blocked
