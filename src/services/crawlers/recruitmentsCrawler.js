const puppeteer = require('puppeteer');
const { query } = require('../../config/database');
const logger = require('../logger');
const Normalizer = require('../normalizer');

class RecruitmentsCrawler {
    constructor() {
        this.delayMs = 1500;
        this.currentJobId = null;
        this.isPaused = false;
        this.isStopped = false;
        this.batchSize = 100;
    }

    pause() {
        this.isPaused = true;
        logger.info('Recruitments crawler paused.');
    }

    resume() {
        this.isPaused = false;
        logger.info('Recruitments crawler resumed.');
    }

    stop() {
        this.isStopped = true;
        logger.info('Recruitments crawler stopped.');
    }

    async crawl(locationStr = null) {
        logger.info('Starting Recruitments crawler job.');
        
        try {
            this.currentJobId = await this.createCrawlerJob();
            await this.updateGlobalStatus(true, this.currentJobId);
            
            this.browser = await puppeteer.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            this.page = await this.browser.newPage();
            await this.page.setDefaultNavigationTimeout(60000);
            await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
            
            logger.info('Discovering recruitments...');
            let rawRecruitments = await this.discoverRecruitments(locationStr);

            if (this.isStopped) {
                logger.info('Crawler stopped during discovery phase. Aborting.');
                await this.completeCrawlerJob(this.currentJobId, 0);
                await this.updateGlobalStatus(false, null);
                return 0;
            }

            // Do not artificially cap the raw array length, let the database track progress
            logger.info(`Found ${rawRecruitments.length} raw recruitments available to scan.`);

            // Update estimated total to represent the full discover list
            await query('UPDATE crawler_jobs SET estimated_total = $1 WHERE id = $2', [rawRecruitments.length, this.currentJobId]);

            let totalFetched = 0;
            let currentBatch = 1;

            for (const recruitment of rawRecruitments) {
                if (this.isStopped) break;

                // Watch for external Database stop signals from Admin Dashboard
                try {
                    const statusCheck = await query('SELECT is_running FROM crawler_status WHERE id = 3');
                    if (statusCheck.rows[0] && statusCheck.rows[0].is_running === false) {
                        logger.info('External Stop signal received from database. Aborting CLI Crawler loop.');
                        this.isStopped = true;
                        break;
                    }
                } catch(e) {}

                while (this.isPaused) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                try {
                    await this.updateJobProgress(this.currentJobId, {
                        current_batch: currentBatch++,
                        total_fetched: totalFetched,
                        status: `Processing ${recruitment.post_name.substring(0, 30)}...`
                    });

                    if (await this.isDuplicateRecruitment(recruitment.post_name, recruitment.organization)) {
                        await query('UPDATE crawler_jobs SET duplicate_count = duplicate_count + 1 WHERE id = $1', [this.currentJobId]);
                        // Do NOT increment totalFetched for duplicates, otherwise batch is wasted
                        continue;
                    }

                    // Perform Deep Scrape if deep link exists
                    const detailedRecruitment = await this.fetchDeepRecruitmentDetails(recruitment);

                    const normalized = this.normalizeRecruitment(detailedRecruitment, locationStr || 'Central');
                    const result = await this.saveRecruitment(normalized);

                    if (result === 'duplicate') {
                        totalFetched++;
                        await query('UPDATE crawler_jobs SET duplicate_count = duplicate_count + 1 WHERE id = $1', [this.currentJobId]);
                    } else if (result) {
                        totalFetched++;
                        await query('UPDATE crawler_jobs SET success_count = success_count + 1 WHERE id = $1', [this.currentJobId]);
                        
                        if (totalFetched >= this.batchSize) {
                            logger.info(`Reached requested batch size of ${this.batchSize}. Stopping crawler loop.`);
                            break;
                        }
                    } else {
                        totalFetched++;
                        await query('UPDATE crawler_jobs SET failed_count = failed_count + 1 WHERE id = $1', [this.currentJobId]);
                    }

                    await new Promise(resolve => setTimeout(resolve, this.delayMs));
                } catch (err) {
                    logger.error(`Failed to process recruitment ${recruitment.post_name}:`, err.message);
                    await this.incrementErrorCount(this.currentJobId);
                }
            }

            // Mark job as completed
            await this.completeCrawlerJob(this.currentJobId, totalFetched);
            await this.updateGlobalStatus(false, null);

            logger.info(`Recruitments crawler completed successfully. Total fetched: ${totalFetched}`);
            return totalFetched;

        } catch (error) {
            logger.error('Recruitments Crawler error:', error);
            if (this.currentJobId) await this.failCrawlerJob(this.currentJobId, error.message);
            await this.updateGlobalStatus(false, null, error.message);
            throw error;
        } finally {
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
                this.page = null;
            }
        }
    }

    async discoverRecruitments(locationStr) {
        let recruitments = [];
        const targetState = locationStr ? locationStr.trim() : 'Central';
        
        try {
            logger.info('Puppeteer: fetching FreeJobAlert latest notifications...');
            const targetUrl = 'https://www.freejobalert.com/latest-notifications/'; 
            
            await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            
            const scrapedJobs = await this.page.evaluate((userState) => {
                const rows = Array.from(document.querySelectorAll('.lattbl tr'));
                // Skip headers (first 2 rows)
                const jobRows = rows.slice(2);
                
                return jobRows.map(tr => {
                    const tds = tr.querySelectorAll('td');
                    if (tds.length < 5) return null;
                    
                    const dt = tds[0]?.innerText?.trim() || '';
                    const board = tds[1]?.innerText?.trim() || '';
                    const postDesc = tds[2]?.innerText?.trim() || '';
                    const link = tds[tds.length - 1]?.querySelector('a')?.href;
                    
                    if (!board || !link || !link.includes('freejobalert')) return null;
                    
                    return {
                        post_name: (board + ' - ' + postDesc).substring(0, 255),
                        organization: board,
                        state: userState, // Fix: Properly bind user's requested search state so it shows on Dashboard!
                        application_end_date: null,
                        source_url: link,
                        source_website: 'freejobalert.com',
                        deep_link: link
                    };
                }).filter(Boolean);
            }, targetState);

            if (scrapedJobs && scrapedJobs.length > 0) {
                logger.info(`Successfully scraped ${scrapedJobs.length} real jobs from FreeJobAlert.`);
                recruitments = scrapedJobs;
            } else {
                logger.warn('No jobs found. FreeJobAlert selectors might have changed.');
            }
            
        } catch (error) {
            logger.error(`Puppeteer scraping failed (${error.message}).`);
        }

        return recruitments;
    }

    async fetchDeepRecruitmentDetails(recruitment) {
        if (!recruitment.deep_link || !recruitment.deep_link.startsWith('http')) return recruitment;
        
        try {
            await this.page.goto(recruitment.deep_link, { waitUntil: 'domcontentloaded', timeout: 15000 });
            
            const details = await this.page.evaluate(() => {
                const data = {};
                
                // Extract Application Fee from FreeJobAlert tables
                const feeTable = Array.from(document.querySelectorAll('tr, p')).find(t => t.innerText && t.innerText.includes('Application Fee'));
                if (feeTable) {
                    try {
                        const feeText = feeTable.innerText.split('Fee')[1]?.trim().replace(/\\s+/g, ' ') || feeTable.innerText;
                        data.application_fee = feeText.substring(0, 200); 
                    } catch(e) {}
                }

                // Extract Apply Online link
                const applyLink = Array.from(document.querySelectorAll('a')).find(a => a.innerText && a.innerText.toLowerCase().includes('apply online'));
                if (applyLink) {
                    data.official_notification_link = applyLink.href;
                }

                return data;
            });
            
            if (details.application_fee) recruitment.application_fee = details.application_fee;
            if (details.official_notification_link) recruitment.official_notification_link = details.official_notification_link;
            
            logger.info(`Deep scraped details for ${recruitment.post_name}`);
        } catch(err) {
            logger.warn(`Failed deep scrape for recruitment link ${recruitment.deep_link}: ${err.message}`);
        }
        
        return recruitment;
    }

    async isDuplicateRecruitment(post_name, organization) {
        try {
            const existCheck = await query(
                'SELECT id FROM recruitments WHERE post_name = $1 AND organization = $2',
                [post_name, organization]
            );
            if (existCheck.rows.length > 0) return true;

            const crawlCheck = await query(
                `SELECT id FROM crawl_results 
                 WHERE type = 'recruitment' 
                 AND json_extract(normalized_data, '$.post_name') = $1 
                 AND json_extract(normalized_data, '$.organization') = $2`,
                [post_name, organization]
            );
            if (crawlCheck.rows.length > 0) return true;
        } catch (e) {
            logger.warn(`isDuplicate check error: ${e.message}`);
        }
        return false;
    }

    async saveRecruitment(data) {
        try {
            if (await this.isDuplicateRecruitment(data.post_name, data.organization)) {
                return 'duplicate';
            }

            await query(
                `INSERT INTO crawl_results (
                    crawl_job_id, source_id, type, raw_data, normalized_data, status
                ) VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    this.currentJobId, 
                    4, // Custom source ID for Majhi Naukari
                    'recruitment',
                    JSON.stringify(data),
                    JSON.stringify(data),
                    'pending'
                ]
            );

            return true;
        } catch (error) {
            logger.error(`Error saving recruitment ${data.post_name}:`, error.message);
            return false;
        }
    }

    normalizeRecruitment(rawData, state) {
        return Normalizer.normalizeRecruitment(rawData, state);
    }

    /* --- Job Management --- */
    createCrawlerJob() {
        return new Promise((resolve, reject) => {
            const sqlite3 = require('sqlite3');
            const path = require('path');
            const dbPath = path.resolve(__dirname, '../../../database.sqlite');
            const db = new sqlite3.Database(dbPath);
            
            db.run(
                `INSERT INTO crawler_jobs (job_type, status, total_fetched)
                 VALUES (?, 'running', 0)`,
                ['recruitments'],
                function(err) {
                    db.close();
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    async updateJobProgress(jobId, data) {
        await query(
            `UPDATE crawler_jobs 
             SET total_fetched = $1, last_updated = CURRENT_TIMESTAMP
             WHERE id = $2`,
             [data.total_fetched, jobId]
        );
    }

    async completeCrawlerJob(jobId, totalSaved) {
        await query(
            `UPDATE crawler_jobs 
             SET status = 'completed', total_fetched = $1, completed_at = CURRENT_TIMESTAMP, last_updated = CURRENT_TIMESTAMP
             WHERE id = $2`,
             [totalSaved, jobId]
        );
    }

    async incrementErrorCount(jobId) {
        await query('UPDATE crawler_jobs SET failed_count = failed_count + 1 WHERE id = $1', [jobId]);
    }

    async failCrawlerJob(jobId, errorMessage) {
        await query(
            `UPDATE crawler_jobs 
             SET status = 'failed', error_message = $1, completed_at = CURRENT_TIMESTAMP, last_updated = CURRENT_TIMESTAMP
             WHERE id = $2`,
             [errorMessage, jobId]
        );
    }

    async updateGlobalStatus(isRunning, jobId, errorMessage = null) {
        let updateQuery = `
            UPDATE crawler_status SET 
            is_running = $1,
            current_job_id = $2,
            last_error = $3,
            updated_at = CURRENT_TIMESTAMP
        `;
        let params = [isRunning ? 1 : 0, jobId, errorMessage];

        if (!isRunning && !errorMessage) {
            updateQuery += `, total_runs = total_runs + 1, total_success = total_success + 1, last_success_at = CURRENT_TIMESTAMP, last_run_at = CURRENT_TIMESTAMP`;
        } else if (!isRunning && errorMessage) {
            updateQuery += `, total_runs = total_runs + 1, total_failures = total_failures + 1, last_run_at = CURRENT_TIMESTAMP`;
        } else if (isRunning) {
            updateQuery += `, last_run_at = CURRENT_TIMESTAMP`;
        }
        
        updateQuery += ` WHERE id = 3`;
        await query(updateQuery, params);
    }

}

module.exports = RecruitmentsCrawler;
