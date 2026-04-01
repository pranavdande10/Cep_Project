const SchemesCrawler = require('./src/services/crawlers/schemesCrawler');

async function test() {
    console.log('--- Starting Crawler Test ---');
    const crawler = new SchemesCrawler();
    crawler.batchSize = 2;
    try {
        const result = await crawler.crawl();
        console.log('Crawled Count:', result);
    } catch (e) {
        console.error('Crawler threw error:', e);
    }
}

test();
