const BaseCrawler = require('./BaseCrawler');
const Normalizer = require('../normalizer');
const logger = require('../logger');

/**
 * TendersCrawler
 * ──────────────
 * Target: https://eprocure.gov.in
 *
 * STATUS: Stub — HTML selectors need to be mapped to the live site structure.
 * The BaseCrawler fetch/retry/UA-rotation infrastructure is fully wired up.
 * To activate: set source is_active=1 in the sources table and implement
 * parseHTMLResponse() with real selectors from eProcure.gov.in.
 */
class TendersCrawler extends BaseCrawler {
    constructor(source) {
        super(source);
    }

    async crawlState(state) {
        try {
            const url = `${this.source.url}eprocure/app?page=FrontEndTendersByOrganisation&service=page&state=${encodeURIComponent(state)}`;
            logger.debug(`Fetching tenders for ${state} from ${url}`);

            const response = await this.fetchWithRetry(url);
            if (!response || !response.data) return [];

            return this.parseHTMLResponse(response.data, state);
        } catch (error) {
            logger.error(`Error crawling tenders for ${state}:`, error.message);
            return [];
        }
    }

    parseHTMLResponse(html, state) {
        try {
            const $ = this.parseHTML(html);
            const tenders = [];

            // TODO: inspect https://eprocure.gov.in and update these selectors
            $('table.list_table tr').each((i, element) => {
                if (i === 0) return; // skip header row
                const $cells = $(element).find('td');
                if ($cells.length < 3) return;

                const tender = {
                    tender_name:   $cells.eq(1).text().trim(),
                    tender_id:     $cells.eq(0).text().trim(),
                    state,
                    department:    $cells.eq(2).text().trim(),
                    closing_date:  $cells.eq(4).text().trim(),
                    url:           $(element).find('a').first().attr('href'),
                    source_website: this.source.url
                };

                if (tender.tender_name) tenders.push(tender);
            });

            return tenders;
        } catch (error) {
            logger.error('Error parsing tenders HTML:', error.message);
            return [];
        }
    }

    normalize(rawData, state) {
        return Normalizer.normalizeTender(rawData, state);
    }
}

module.exports = TendersCrawler;
