// Central dispatcher (Step 2 + Step 3.1 + Step 3.2)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "executeCommand") return;

  const data = msg.data || {};
  const command = (data.command || "").toLowerCase();
  const args = data.args || {};

  switch (command) {
    case "open_tab": {
      const url = args?.url;
      if (!url) {
        sendResponse({ status: "error", message: "Missing url" });
        break;
      }
      chrome.tabs.create({ url });
      sendResponse({ status: "ok", action: "opened_tab", url });
      break;
    }

    case "scroll": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs?.[0]?.id;
        if (!tabId) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }
        const direction = args?.direction === "up" ? "up" : "down";
        chrome.scripting.executeScript(
          {
            target: { tabId },
            args: [direction],
            func: (dir) => {
              const amount = window.innerHeight;
              const target =
                document.scrollingElement ||
                document.body ||
                document.documentElement;

              if (dir === "up") {
                target.scrollBy(0, -amount);
              } else {
                target.scrollBy(0, amount);
              }
            }
          },
          () => {
            sendResponse({ status: "ok", action: "scrolled", direction });
          }
        );
      });
      return true; // async
    }

    case "search_web": {
      const query = args?.query?.trim();
      if (!query) {
        sendResponse({ status: "error", message: "Missing query" });
        break;
      }

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs?.[0]?.id;
        if (!tabId) {
          sendResponse({ status: "error", message: "No active tab found" });
          return;
        }

        // Try site search first. If not possible, fall back to Google.
        chrome.scripting.executeScript(
          {
            target: { tabId },
            args: [query],
            func: (q) => {
              const visible = (el) => !!(el && el.offsetParent !== null && !el.disabled);

              const selectors = [
                'input[type="search"]',
                'input[role="searchbox"]',
                'input[name*="search" i]',
                'input[id*="search" i]',
                'input[aria-label*="search" i]',
                'input[placeholder*="search" i]',
                '[role="search"] input',
                'textarea[role="searchbox"]'
              ];

              let input =
                Array.from(document.querySelectorAll(selectors.join(","))).find(visible) ||
                Array.from(document.querySelectorAll('input[type="text"]')).find(
                  (el) =>
                    visible(el) &&
                    /search|find/i.test(
                      (el.placeholder || "") +
                        " " +
                        (el.getAttribute("aria-label") || "") +
                        " " +
                        (el.name || "") +
                        " " +
                        (el.id || "")
                    )
                );

              if (!input) return { success: false, reason: "no_input" };

              // Set value in a way frameworks detect
              const proto = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype,
                "value"
              );
              proto?.set?.call(input, q);
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));

              // Submit via form if available
              let form = input.form || input.closest("form");
              if (form && typeof form.submit === "function") {
                form.submit();
                return { success: true, method: "form" };
              }

              // Try click a submit/search button
              const btn =
                input
                  .closest("form")
                  ?.querySelector('button[type="submit"], input[type="submit"]') ||
                document.querySelector(
                  'button[aria-label*="search" i], button[type="submit"], input[type="submit"]'
                );

              if (btn) {
                btn.click();
                return { success: true, method: "button" };
              }

              // Simulate Enter key
              const press = (type) =>
                input.dispatchEvent(
                  new KeyboardEvent(type, {
                    key: "Enter",
                    keyCode: 13,
                    which: 13,
                    bubbles: true
                  })
                );
              press("keydown");
              press("keypress");
              press("keyup");
              return { success: true, method: "enter" };
            }
          },
          (results) => {
            const ok = Array.isArray(results) && results[0]?.result?.success;
            if (ok) {
              sendResponse({ status: "ok", action: "search_in_page", query });
            } else {
              const google =
                "https://www.google.com/search?q=" + encodeURIComponent(query);
              chrome.tabs.create({ url: google });
              sendResponse({
                status: "ok",
                action: "search_google_fallback",
                query
              });
            }
          }
        );
      });
      return true; // async
    }

    case "click_ui": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs?.[0]?.id;
        const label = args?.text;
        if (!tabId || !label) {
          sendResponse({ status: "error", message: "Missing text or no active tab" });
          return;
        }

        chrome.scripting.executeScript(
          {
            target: { tabId },
            args: [label],
            func: (needle) => {
              const isVisible = (el) => !!(el && el.offsetParent !== null);

              const candidates = [];
              const pushIfMatch = (el, txt) => {
                const text = (txt || "").trim();
                if (!text) return;
                if (!isVisible(el)) return;
                if (text.toLowerCase().includes(needle.toLowerCase())) {
                  candidates.push(el);
                }
              };

              const nodes = document.querySelectorAll(
                'button, a, [role="button"], [aria-label], [title], input[type="button"], input[type="submit"]'
              );

              nodes.forEach((el) => {
                pushIfMatch(el, el.innerText);
                pushIfMatch(el, el.value);
                pushIfMatch(el, el.getAttribute("aria-label"));
                pushIfMatch(el, el.title);
              });

              if (candidates.length) {
                const el = candidates[0];
                el.click();
                return {
                  success: true,
                  clicked:
                    el.innerText || el.value || el.getAttribute("aria-label") || needle
                };
              }

              return { success: false, reason: "not_found" };
            }
          },
          (results) => {
            const ok = Array.isArray(results) && results[0]?.result?.success;
            if (ok) {
              sendResponse({
                status: "ok",
                action: "clicked",
                text: results[0].result.clicked
              });
            } else {
              sendResponse({ status: "error", message: "No matching element found" });
            }
          }
        );
      });
      return true; // async
    }

    default:
      sendResponse({ status: "noop", message: `Unsupported command: ${command}` });
  }
});
