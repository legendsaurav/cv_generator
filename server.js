const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const rootDir = __dirname;

function loadEnvFile() {
    const envPath = path.join(rootDir, '.env');
    if (!fs.existsSync(envPath)) {
        return;
    }

    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const equalsIndex = trimmed.indexOf('=');
        if (equalsIndex === -1) continue;
        const key = trimmed.slice(0, equalsIndex).trim();
        const value = trimmed.slice(equalsIndex + 1).trim().replace(/^['"]|['"]$/g, '');
        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

function contentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') return 'text/html; charset=utf-8';
    if (ext === '.css') return 'text/css; charset=utf-8';
    if (ext === '.js') return 'application/javascript; charset=utf-8';
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.svg') return 'image/svg+xml';
    if (ext === '.ico') return 'image/x-icon';
    return 'application/octet-stream';
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 1e6) {
                req.destroy();
                reject(new Error('Request body too large'));
            }
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function buildPrompt(text, mode) {
    const trimmed = text.trim();
    const looksLikePoints = mode === 'bullets' || /\n|^[\s\-*•\u2022]/m.test(trimmed);

    if (looksLikePoints) {
        return [
            'Rewrite the text as concise bullet points.',
            'Keep every important detail, but make the wording shorter, clearer, and more professional.',
            'Do not add new information or remove meaningful facts.',
            'Return only the rewritten bullet points.'
        ].join(' ');
    }

    return [
        'Rewrite the text into a shorter, polished sentence or two.',
        'Preserve the original meaning and important details.',
        'Use compact, professional wording and do not add new information.',
        'Return only the rewritten text.'
    ].join(' ');
}

async function enhanceWithGemini(text, mode) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY is not configured');
    }

    const prompt = buildPrompt(text, mode);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: `${prompt}\n\nInput:\n${text.trim()}` }] }],
            generationConfig: {
                temperature: 0.2,
                topP: 0.8,
                maxOutputTokens: 256
            }
        })
    });

    const data = await response.json();
    if (!response.ok) {
        const message = data && data.error && data.error.message ? data.error.message : 'Gemini request failed';
        throw new Error(message);
    }

    const output = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
    if (!output) {
        throw new Error('Gemini returned an empty response');
    }

    return output;
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}

function serveStatic(req, res, pathname) {
    const safePath = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(rootDir, safePath);
    if (!filePath.startsWith(rootDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
    }

    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    fs.createReadStream(filePath).pipe(res);
}

loadEnvFile();

const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && requestUrl.pathname === '/api/enhance') {
        try {
            const rawBody = await readRequestBody(req);
            const body = rawBody ? JSON.parse(rawBody) : {};
            const text = typeof body.text === 'string' ? body.text : '';
            const mode = typeof body.mode === 'string' ? body.mode : 'auto';

            if (!text.trim()) {
                sendJson(res, 400, { error: 'Text is required' });
                return;
            }

            const enhanced = await enhanceWithGemini(text, mode);
            sendJson(res, 200, { text: enhanced });
        } catch (error) {
            sendJson(res, 500, { error: error.message || 'Unable to enhance text' });
        }
        return;
    }

    serveStatic(req, res, requestUrl.pathname);
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
    console.log(`Resume generator running at http://localhost:${port}`);
});