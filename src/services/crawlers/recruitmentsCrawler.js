const BaseCrawler = require('./BaseCrawler');
const Normalizer = require('../normalizer');
const logger = require('../logger');

/**
 * RecruitmentsCrawler
 * ───────────────────
 * Target: https://www.ncs.gov.in (National Career Service Portal)
 *
 * STATUS: Stub — HTML selectors need to be mapped to the live site structure.
 * To activate: set source is_active=1 in the sources table and implement
 * parseHTMLResponse() with real selectors from ncs.gov.in.
 */
class RecruitmentsCrawler extends BaseCrawler {
    constructor(source) {
        super(source);
    }

    async crawlState(state) {
        try {
            const location = state === 'Central' ? 'All+India' : encodeURIComponent(state);
            const url = `${this.source.url}jobs?location=${location}`;
            logger.debug(`Fetching recruitments for ${state} from ${url}`);

            const response = await this.fetchWithRetry(url);
            if (!response || !response.data) return [];

            return this.parseHTMLResponse(response.data, state);
        } catch (error) {
            logger.error(`Error crawling recruitments for ${state}:`, error.message);
            return [];
        }
    }

    parseHTMLResponse(html, state) {
        try {
            const $ = this.parseHTML(html);
            const recruitments = [];

            // TODO: inspect https://www.ncs.gov.in and update these selectors
            $('.job-item, .vacancy-row').each((i, element) => {
                const $el = $(element);
                const recruitment = {
                    post_name:            $el.find('.job-title, h3').first().text().trim(),
                    organization:         $el.find('.organization, .department').text().trim(),
                    state,
                    vacancies:            $el.find('.vacancy-count').text().trim(),
                    application_end_date: $el.find('.deadline, .last-date').text().trim(),
                    url:                  $el.find('a').first().attr('href'),
                    source_website:       this.source.url
                };

                if (recruitment.post_name) recruitments.push(recruitment);
            });

            return recruitments;
        } catch (error) {
            logger.error('Error parsing recruitments HTML:', error.message);
            return [];
        }
    }

    normalize(rawData, state) {
        return Normalizer.normalizeRecruitment(rawData, state);
    }
}

module.exports = RecruitmentsCrawler;
