import puppeteer, { Browser, Page } from "puppeteer";
import * as Bluebird from "bluebird";
import * as _ from "lodash";

const fs = require('fs');
const { globSync } = require('glob');

const ESSAYS_DLL_DIR = 'essays';

// Entrypoint for the script
(async () => {
  // 1. Initialize a Puppeteer "Browser" object
  const browser: Browser = await getBrowser();
  // 2. Get the urls of all PG essays
  const allEssayUrls: string[] = await getAllEssayUrls(browser);
  // 3. Filter out essay urls that we don't need/want to download
  const essayUrlsToDownload: string[] = getEssayUrlsToDownload(allEssayUrls);
  // 4. Visit and download all essay urls
  await downloadEssays(browser, essayUrlsToDownload);
  // 5. Clean up the Puppeteer/Chromium resourses created
  await browser.close();
})();

// Filters essay urls to exclude any essays that have already been downloaded 
function getEssayUrlsToDownload(essayUrls: string[]): string[] {
  const existingEssayIds: string[] = getExistingEssayIds();
  const essayUrlsToDownload: string[] = essayUrls.filter(url => {
    return !(_.includes(existingEssayIds, getIdFromEssayUrl(url)));
  });

  console.log({ NumberOfExistingEssays: existingEssayIds.length});
  console.log({ NumberOfNewEssaysToDownload: essayUrlsToDownload.length });

  return essayUrlsToDownload;
}

// Instantiates a Puppeteer Browser, with Chromium browser as default
async function getBrowser(): Promise<Browser> {
  const browser: Browser = await puppeteer.launch({
    headless: true, // Change to false if you'd like to see the Browser window when the script is running   
    args: [`--window-size=1080,1024 --Mozilla/5.0 (iPhone; CPU iPhone OS 16_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1`],
    defaultViewport: {
      width:1080,
      height:1024
    },
  });
  return browser;
}

// Visits the essays index page and determines the list of all essay urls 
async function getAllEssayUrls(browser: Browser): Promise<string[]> {
  const page: Page = await browser.newPage();

  // Open the main article index
  await page.goto('http://www.paulgraham.com/articles.html', { waitUntil: 'networkidle2' });
  
  // Use CSS selectors to get all essay urls (i.e html href elements)
  const hrefElements = await page.$$("font > a");
  const allUrls: string[] = await Promise.all(
    hrefElements.map(async (he) => he?.evaluate(e => e.href))
  );     
  // Filter out any urls that link to a different website
  const pgUrls = allUrls.filter(url => url.startsWith("http://www.paulgraham.com/"))
  console.log({ NumberOfUrlsFound: pgUrls.length })

  // This is a list of some unwanted urls/essays that I've noticed
  // identified by their suffixes, these essays will not be downloaded
  const unwantedEssaySuffixes = [
    "rss.html",
    "index.html",
    "fix.html",
    "noop.html",
    "rootsoflisp.html",
    "langdes.html",
    "lwba.html",
    "progbot.html"
  ]

  // Filter out essay urls if they have one the unwanted url suffixes
  const keepUrls: string[] = pgUrls.filter(url => {
    return unwantedEssaySuffixes.every((suffix) => !url.endsWith(suffix))
  });

  // Remove duplicate essay urls
  const uniqueUrls = Array.from(new Set(keepUrls));
  console.log({ NumberOfUniqueUrls: uniqueUrls.length })

  return uniqueUrls;
}

// Visits and downloads each essay url passed
async function downloadEssays(browser: Browser, essayUrls: string[]) {
  // Create a single tab or "Page" object on the Puppeteer browser
  const page: Page = await browser.newPage();

  // One-by-one calls 'downloadEssay' for each url provided
  // A single Puppeteer tab/page is reused, as I have chosen not to use parallelization
  // A 4 second delay is added between each download (to be nice to PG's website)
  await Bluebird.mapSeries(essayUrls, url => {
    return Bluebird.delay(4000)
      .then(() => downloadEssay(page, url))
  });
}

// This function parses the publish month/year from the essay page
// month/year has to be parsed differently on certain essays, so we use two selectors (font, p)
// e.g. http://www.paulgraham.com/highres.html vs http://www.paulgraham.com/fr.html
// Parsing HTML is always prone to breaking, so I've added a catch all that saves essays as unkw/unkw
async function getMonthAndDateFromPage(page: Page): Promise<string[]> {
  try {
    let publishDateElement = await page.$('font');
    let publishDateHTML: string = await publishDateElement?.evaluate(el => el.innerHTML)!;
    let [parsedMonth, parsedYear] = publishDateHTML.split("<br>")[0].split(" ");

    if (MONTH_MAP.has(parsedMonth)) {
      // The parsed year sometimes has a trailing comma
      parsedYear = parsedYear.endsWith(',') ? parsedYear.slice(0, -1) : parsedYear;
      return [parsedMonth, parsedYear]
    } 
  
    publishDateElement = await page.$('p');
    publishDateHTML = await publishDateElement?.evaluate(el => el.innerHTML)!;
    [parsedMonth, parsedYear] = publishDateHTML.split("<br>")[0].split('\n')[1].split(" ");

    if (MONTH_MAP.has(parsedMonth)) {
      // The parsed year sometimes has a trailing comma
      parsedYear = parsedYear.endsWith(',') ? parsedYear.slice(0, -1) : parsedYear;
      return [parsedMonth, parsedYear]
    }
  } catch (e) {
    console.error('Error occurred when parsing HTML, returning placeholder month/year');
  }
  // Month/Year Placeholder values
  return ['Unknown', '2xxx']
}

// Visits and downloads a single essay page (by url)
async function downloadEssay(page: Page, essayUrl: string) {
  await page.goto(essayUrl, { waitUntil: 'networkidle0' });
  // e.g. `http://www.paulgraham.com/getideas.html` -> "getideas"
  const essayId: string = getIdFromEssayUrl(essayUrl);

  // Parse the essay title and publish year/month values 
  const titleElement = await page.$('body > table > tbody > tr > td:nth-child(3) > table:nth-child(4) > tbody > tr > td > img');
  const title = await titleElement?.evaluate(el => el.getAttribute('alt'))
  const [month, year] = await getMonthAndDateFromPage(page);

  console.log({ title, year, month })

  // Determine the download directory and filename
  const downloadDir = `${ESSAYS_DLL_DIR}/${year}`;
  // e.g 'essays/2023/greatwork-2023-07.pdf'
  const outputFilename = `${downloadDir}/${essayId}-${year}-${MONTH_MAP.get(month)}.pdf`; 
  
  // Create the download directory (if it doesn't already exist)
  if (!fs.existsSync(downloadDir)){
    fs.mkdirSync(downloadDir, { recursive: true })
  }

  console.log(`Saving file: ${outputFilename}..`);

  // Download/save the page contents as a PDF
  await page.pdf({
    path: outputFilename,
    margin: { top: '50px', right: '25px', bottom: '50px', left: '25px' },
    printBackground: true,
    format: 'A4',
  });
}

// Maps an essay url to an identifier/slug 
function getIdFromEssayUrl(essayUrl: string): string {
  // e.g. `http://www.paulgraham.com/getideas.html` -> "getideas"
  return essayUrl.split('/').slice(-1)[0].split('.')[0];
}

// Retrieves the list of essay (ids) that have already been downloaded
function getExistingEssayIds(): string[] {
  const existingFileNames: string[] = globSync(`${ESSAYS_DLL_DIR}/**/*.pdf`);
  const prefixChars = ESSAYS_DLL_DIR.length + 6 
  const suffixChars = 12

  // e.g essays/2020/earnest-2020-12.pdf -> earnest
  const essayIds: string[] = existingFileNames.map(fileName => fileName.slice(0,-suffixChars).slice(prefixChars,)) || [];
  
  return essayIds;
}

const MONTH_MAP = new Map([
  ['January', '01'],
  ['February', '02'],
  ['March', '03'],
  ['April', '04'],
  ['May', '05'],
  ['June', '06'],
  ['July', '07'],
  ['August', '08'],
  ['September', '09'],
  ['October', '10'],
  ['November', '11'],
  ['December', '12'],
  ['Unknown', 'xx'],
]);