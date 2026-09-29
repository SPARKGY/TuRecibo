import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const directory = "test-results/login-no-auth";
await mkdir(directory, { recursive: true });

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const response = await page.goto("https://admin.turecibo.com/s/login", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(5_000);

  const redirects = [];
  for (let request = response?.request(); request; request = request.redirectedFrom()) {
    const url = new URL(request.url());
    redirects.unshift(`${url.hostname}${url.pathname}`);
  }
  const final = new URL(page.url());
  const diagnostic = {
    status: response?.status() ?? null,
    redirects,
    final: `${final.hostname}${final.pathname}`,
    title: await page.title(),
    inputs: await page.locator("input").evaluateAll((inputs) =>
      inputs.map((input) => ({ name: input.getAttribute("name"), type: input.getAttribute("type") })),
    ),
    forms: await page.locator("form").count(),
    frames: page.frames().length,
    bodyTextLength: await page.locator("body").evaluate((body) => body.innerText.length),
  };

  await page.evaluate(() => {
    document.querySelectorAll("input,textarea").forEach((element) => {
      element.value = "";
      element.placeholder = "";
    });
    document.querySelectorAll("img,svg,canvas,video,iframe").forEach((element) => element.remove());
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      if (text.textContent.trim()) text.textContent = "[texto oculto]";
    }
    const style = document.createElement("style");
    style.textContent = "* { background-image: none !important } *::before,*::after { content: none !important }";
    document.head.append(style);
  });
  await page.screenshot({ path: `${directory}/captura-saneada.png`, fullPage: true });
  console.log(JSON.stringify(diagnostic));
} finally {
  await browser.close();
}
