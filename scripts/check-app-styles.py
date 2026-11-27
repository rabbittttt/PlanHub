"""Check the shared navigation design against a running workbench in Edge."""
import argparse
import json
import sys
from urllib.parse import parse_qs, urlsplit
from pathlib import Path

from playwright.sync_api import Error, expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
# Only the element lookup is application-specific. Each check uses rendered values.
ANALYTICS = (".brand strong", "#moduleNav")
CONTROLS = {
    "orderiq": ANALYTICS,
    "forecast": ANALYTICS,
    "leads": ANALYTICS,
    "boutique": ANALYTICS,
    "sop": (".app-brand strong", ".top-nav"),
    "quicklook": (":is(.workspace-header, .compact-header):has(#nav) .brand :is(span, strong)", "#nav"),
    "vehicle-config": (".product-title", "header nav"),
}
CANVAS = "rgb(244, 246, 249)"
SELECTED = "rgb(237, 242, 255)"
ACCENT = "rgb(32, 73, 212)"


def check_page(doc, title):
    expect(doc.locator("body")).to_have_css("background-color", CANVAS)
    expect(title).to_have_css("font-size", "19px")
    expect(title).to_have_css("font-weight", "700")
    widths = doc.locator("html").evaluate("e => [e.scrollWidth, e.clientWidth]")
    if widths[0] > widths[1] + 1:
        raise AssertionError(f"页面横向溢出 {widths[0]} > {widths[1]}")


def check_keyboard_focus(page, control):
    # Use keyboard modality even when the preceding case used a mouse click.
    page.keyboard.press("Tab")
    control.focus()
    visible = control.evaluate("""e => {
        const s = getComputedStyle(e);
        return e.matches(':focus-visible') &&
            ((s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none');
    }""")
    if not visible:
        raise AssertionError("导航控件缺少可见键盘焦点")


def check_app(page, app_id):
    title, navigation = CONTROLS[app_id]
    page.locator(f'#app-nav [data-app="{app_id}"]').click()
    doc = page.frame_locator(f'iframe[data-app="{app_id}"]:visible')
    heading = doc.locator(title)
    expect(heading).to_be_visible(timeout=20000)
    nav = doc.locator(navigation)
    active = nav.locator('[aria-current="page"]')
    # Wait for the application to initialize its selection, before testing each navigation state.
    expect(active).to_have_count(1)
    check_page(doc, heading)
    checked = set()
    check_tabs(page, nav, active, checked)
    if app_id == "orderiq":
        # Some order reports only exist for individual vehicles.
        subjects = doc.locator("#subjectSelect")
        frame = doc.owner.element_handle().content_frame()
        for value in subjects.locator("option:enabled").evaluate_all("opts => opts.map(o => o.value)"):
            if len(checked) >= nav.locator("button").count():
                break
            if value == subjects.input_value():
                continue
            subjects.select_option(value)
            frame.wait_for_url(lambda url: parse_qs(urlsplit(url).query).get("subject") == [value])
            check_tabs(page, nav, active, checked)
    return len(checked)


def check_tabs(page, nav, active, checked):
    expect(nav).to_be_visible()
    expect(nav).to_have_css("column-gap", "2px")
    expect(nav).to_have_css("scrollbar-width", "none")
    buttons = nav.locator('button:enabled:visible')
    count = buttons.count()
    if not count:
        raise AssertionError("没有可用的主导航标签")
    for index in range(count):
        button = buttons.nth(index)
        label = button.inner_text().strip()
        if label in checked:
            continue
        try:
            # Move away before sampling the default state after scrolling or switching tabs.
            page.mouse.move(0, 0)
            button.scroll_into_view_if_needed()
            expect(button).to_have_css("height", "56px")
            expect(button).to_have_css("min-height", "56px")
            expect(button).to_have_css("padding-left", "16px")
            expect(button).to_have_css("padding-right", "16px")
            expect(button).to_have_css("column-gap", "7px")
            expect(button).to_have_css("font-size", "14px")
            expect(button).to_have_css("white-space", "nowrap")
            expect(button).to_have_css("border-radius", "0px")
            expect(button).to_have_css("border-bottom-style", "solid")
            # The browser snaps a 2.5 CSS pixel border to a whole device pixel.
            border = button.evaluate("""el => {
                const scale = devicePixelRatio;
                return parseFloat(getComputedStyle(el).borderBottomWidth) === Math.floor(2.5 * scale) / scale;
            }""")
            if not border:
                raise AssertionError("页签底边应为 2.5 CSS 像素")
            icon = button.locator("svg").first
            if button.get_attribute("aria-current") != "page":
                expect(button).to_have_css("font-weight", "400")
                expect(button).to_have_css("color", "rgb(96, 103, 117)")
                expect(button).to_have_css("background-color", "rgba(0, 0, 0, 0)")
                if icon.count():
                    expect(icon).to_have_css("opacity", "0.8")
                button.hover()
                expect(button).to_have_css("background-color", SELECTED)
                expect(button).to_have_css("color", ACCENT)
                expect(button).to_have_css("font-weight", "400")
                expect(button).to_have_css("border-bottom-color", "rgba(0, 0, 0, 0)")
            # Test the focus ring before navigation moves focus into the new view.
            check_keyboard_focus(page, button)
            button.click()
            expect(button).to_have_attribute("aria-current", "page")
            expect(active).to_have_count(1)
            expect(button).to_have_css("height", "56px")
            expect(button).to_have_css("background-color", SELECTED)
            expect(button).to_have_css("color", ACCENT)
            expect(button).to_have_css("font-weight", "700")
            expect(button).to_have_css("border-bottom-color", "rgb(40, 89, 245)")
            expect(button).to_have_css("box-shadow", "none")
            if icon.count():
                expect(icon).to_have_css("opacity", "1")
            expect(button).to_be_in_viewport(ratio=0.99)
            checked.add(label)
        except (AssertionError, Error) as exc:
            raise AssertionError(f"{label}: {exc}") from exc


def main():
    port = json.loads((ROOT / "integration/ports.json").read_text(encoding="utf-8"))["portal"]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=f"http://127.0.0.1:{port}")
    args = parser.parse_args()
    failures = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge")
        for width in (1440, 390):
            page = browser.new_page(viewport={"width": width, "height": 900},
                                    color_scheme="light", reduced_motion="reduce")
            try:
                page.goto(args.url.rstrip("/") + "/#/home")
                heading = page.locator("#home-title")
                expect(heading).to_be_visible()
                check_page(page, heading)
                entries = page.locator("#app-nav [data-app]").evaluate_all(
                    "links => links.filter(a => !a.querySelector('.nav-pending')).map(a => a.dataset.app)"
                )
                for app_id in CONTROLS:
                    if app_id not in entries:
                        print(f"SKIP {width} {app_id}（当前门户未启用或未就绪）")
                apps = [key for key in entries if key in CONTROLS]
                if not apps:
                    raise AssertionError("当前门户没有启用可检查的应用")
                for key in entries:
                    if key not in CONTROLS:
                        print(f"SKIP {width} {key}（未登记导航控件）")
                for app_id in apps:
                    try:
                        count = check_app(page, app_id)
                        print(f"PASS {width} {app_id} ({count})")
                    except (AssertionError, Error) as exc:
                        failures.append(f"{width} {app_id}: {exc}")
            except (AssertionError, Error) as exc:
                failures.append(f"{width} 工作台: {exc}")
            finally:
                page.close()
        browser.close()
    for failure in failures:
        print(failure, file=sys.stderr)
    return int(bool(failures))


if __name__ == "__main__":
    sys.exit(main())
