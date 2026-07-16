const fs = require('fs');
const path = require('path');
const https = require('https');

const PLAYLIST_ID = 'PLHs9m0QEyULCSQ7kIonyUQ5AXl5NwNGHQ';
const PLAYLIST_URL = `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`;
const FEED_URL = `https://www.youtube.com/feeds/videos.xml?playlist_id=${PLAYLIST_ID}`;
const OUTPUT_PATH = path.join(__dirname, '..', 'website', 'tutorials.json');

function decodeXml(value) {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function findTag(block, tagName) {
    const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = block.match(pattern);
    return match ? decodeXml(match[1].trim()) : '';
}

function findLinkHref(block) {
    const match = block.match(/<link[^>]+href="([^"]+)"/i);
    return match ? decodeXml(match[1].trim()) : '';
}

function parseFeed(xmlText) {
    const entryBlocks = xmlText.match(/<entry>[\s\S]*?<\/entry>/gi) || [];
    const items = entryBlocks.map((entry) => {
        const videoId = findTag(entry, 'yt:videoId');
        const title = findTag(entry, 'title');
        const published = findTag(entry, 'published');
        const description = findTag(entry, 'media:description');
        const thumbnail = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '';
        const url = findLinkHref(entry) || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : PLAYLIST_URL);

        return {
            videoId,
            title,
            published,
            description,
            thumbnail,
            url
        };
    }).filter((item) => item.videoId && item.title);

    items.sort((a, b) => new Date(b.published) - new Date(a.published));

    return {
        playlistId: PLAYLIST_ID,
        playlistUrl: PLAYLIST_URL,
        updatedAt: new Date().toISOString(),
        items: items.slice(0, 5)
    };
}

function fetchText(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            headers: {
                'user-agent': 'EVD-Tutorial-Fetcher/1.0 (+https://evd.drenginyilmaz.net/)',
                accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8'
            }
        }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                if (redirectCount >= 5) {
                    reject(new Error(`Too many redirects while fetching ${url}`));
                    response.resume();
                    return;
                }
                const nextUrl = new URL(response.headers.location, url).toString();
                response.resume();
                resolve(fetchText(nextUrl, redirectCount + 1));
                return;
            }

            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}`));
                response.resume();
                return;
            }

            let data = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                data += chunk;
            });
            response.on('end', () => resolve(data));
        });

        request.setTimeout(15000, () => {
            request.destroy(new Error(`Request timed out while fetching ${url}`));
        });

        request.on('error', reject);
    });
}

async function main() {
    let lastError = null;
    let xmlText = '';

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            xmlText = await fetchText(FEED_URL);
            break;
        } catch (error) {
            lastError = error;
            console.warn(`Tutorial feed fetch failed on attempt ${attempt}:`, error.message);
            if (attempt < 3) {
                await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
            }
        }
    }

    if (!xmlText) {
        throw lastError || new Error('Could not fetch tutorial feed.');
    }

    const payload = parseFeed(xmlText);
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`Tutorial feed JSON written to ${OUTPUT_PATH}`);
}

main().catch((error) => {
    console.error('Could not generate tutorials.json:', error);
    process.exitCode = 1;
});
