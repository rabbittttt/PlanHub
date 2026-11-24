"""Check the shared navigation design against a running workbench in Edge."""
import argparse
import json
import sys
from urllib.parse import parse_qs, urlsplit
from pathlib import Path

from playwright.sync_api import Error, expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
# Only the element lookup is application-specific. Each check uses rendered values.
ANALYTICS = (".brand strong", "#moduleNav", "#moduleSelect")
CONTROLS = {
    "orderiq": ANALYTICS,
    "forecast": ANALYTICS,
    "leads": ANALYTICS,
    "sop": (".app-brand strong", ".top-nav", None),
    "quicklook": (".brand span:visible, .brand strong:visible", "#nav", None),
    "vehicle-config": (".product-title", "header nav", "#mobile-tab"),
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
    title, navigation, picker = CONTROLS[app_id]
    page.locator(f'#app-nav [data-app="{app_id}"]').click()
    doc = page.frame_locator(f'iframe[data-app="{app_id}"]:visible')
    heading = doc.locator(title)
    expect(heading).to_be_visible(timeout=20000)
    nav = doc.locator(navigation)
    active = nav.locator('[aria-current="page"]')
    # Wait for the application to initialize its selection, including hidden desktop tabs.
    expect(active).to_have_count(1)
    check_page(doc, heading)
    checked = set()
    check_tabs(page, doc, nav, active, picker, checked)
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
            check_tabs(page, doc, nav, active, picker, checked)
    return len(checked)


def check_tabs(page, doc, nav, active, picker, checked):
    if picker and doc.locator(picker).is_visible():
        select = doc.locator(picker)
        expect(select).to_be_in_viewport(ratio=0.99)
        check_keyboard_focus(page, select)
        options = select.locator("option:enabled").evaluate_all(
            "options => options.map(o => [o.value, o.label.trim()])"
        )
        if not options:
            raise AssertionError("模块选择框没有可用选项")
        for value, label in options:
            if label in checked:
                continue
            select.select_option(value)
            expect(active).to_have_text(label)
            checked.add(label)
        return

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
            button.click()
            expect(button).to_have_attribute("aria-current", "page")
            expect(active).to_have_count(1)
            expect(button).to_have_css("background-color", SELECTED)
            expect(button).to_have_css("color", ACCENT)
            expect(button).to_have_css("font-weight", "600")
            expect(button).to_have_css("font-size", "14px")
            expect(button).to_be_in_viewport(ratio=0.99)
            if button.bounding_box()["height"] < 44:
                raise AssertionError("导航点击区域低于 44px")
            check_keyboard_focus(page, button)
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
