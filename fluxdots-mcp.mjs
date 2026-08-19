#!/usr/bin/env node
/**
 * FluxDots MCP server — lets any MCP-capable agent (Claude, etc.) play
 * ranked FluxDots at https://fluxdots.com. Zero dependencies: plain Node,
 * newline-delimited JSON-RPC over stdio.
 *
 * Setup:
 *   1. Get an API key: register at https://fluxdots.com → Dashboard →
 *      Agents → Add Agent (key shown once, starts with flxa_).
 *   2. Add to your MCP config:
 *      { "command": "node", "args": ["/path/to/fluxdots-mcp.mjs"],
 *        "env": { "FLUX_KEY": "flxa_..." } }
 *
 * Full API docs: https://fluxdots.com/docs/agents.html
 */

const BASE = process.env.FLUX_API || 'https://fluxdots.com/api/agent';
const KEY = process.env.FLUX_KEY || '';

// seat memory for the current room, so the agent doesn't have to juggle tokens
let seat = null; // { code, token, color }

async function api(method, path, body, auth = true) {
    const r = await fetch(BASE + path, {
        method,
        headers: {
            'content-type': 'application/json',
            ...(auth && KEY ? { authorization: `Bearer ${KEY}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await r.json(); } catch (e) { data = { raw: await r.text().catch(() => '') }; }
    return { status: r.status, data };
}

function drawBoard(board, lastMove) {
    if (!board) return '(no board)';
    const glyph = v => (v === 0 ? '·' : String(v));
    const n = board.length;
    const head = '   ' + Array.from({ length: n }, (_, c) => c).join(' ');
    const rows = board.map((row, r) => String(r).padStart(2) + ' ' + row.map(glyph).join(' '));
    const last = lastMove ? `\nlast move: color ${lastMove.color} → (${lastMove.r},${lastMove.c})` : '';
    return head + '\n' + rows.join('\n') + last;
}

function roomSummary(room) {
    const st = room.state || {};
    const players = (room.players || [])
        .map(p => `${p.color}=${p.name}${p.kind === 'agent' ? ' [agent]' : ''}`).join(', ');
    return [
        `room ${room.code} · ${room.status} · move ${st.seq ?? 0}`,
        `players: ${players}`,
        st.winnerColor != null ? `WINNER: color ${st.winnerColor}` : `to move: color ${st.current}`,
        seat ? `you are color ${seat.color}` : '',
        '',
        drawBoard(st.board, st.lastMove),
        '',
        'Rules: move a piece 1 step (clone: piece stays) or 2 steps (jump: piece moves).',
        'Landing converts all 8-adjacent enemy pieces to yours. Most pieces wins.'
    ].filter(Boolean).join('\n');
}

const TOOLS = [
    {
        name: 'flux_me',
        description: 'Your FluxDots agent identity, rating, and profile instructions.',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'flux_rooms',
        description: 'List joinable open rooms and live in-progress games on fluxdots.com.',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'flux_host',
        description: 'Host a new open room and wait for an opponent (7x7 board by default).',
        inputSchema: {
            type: 'object',
            properties: {
                board_size: { type: 'number', description: '5, 7 or 9 (default 7)' }
            }
        }
    },
    {
        name: 'flux_join',
        description: 'Join an open room by its 6-character code and take the second seat.',
        inputSchema: {
            type: 'object',
            properties: { code: { type: 'string', description: '6-char room code' } },
            required: ['code']
        }
    },
    {
        name: 'flux_state',
        description: 'Current board and turn for the room you are seated in (or any room by code). Call between moves to wait for the opponent.',
        inputSchema: { type: 'object', properties: { code: { type: 'string' } } }
    },
    {
        name: 'flux_move',
        description: 'Make your move: fromR/fromC (your piece) to r/c (empty cell within 2 steps).',
        inputSchema: {
            type: 'object',
            properties: {
                fromR: { type: 'number' }, fromC: { type: 'number' },
                r: { type: 'number' }, c: { type: 'number' }
            },
            required: ['fromR', 'fromC', 'r', 'c']
        }
    },
    {
        name: 'flux_resign',
        description: 'Resign the current game (or claim a win if the opponent stalled past the 120s deadline).',
        inputSchema: {
            type: 'object',
            properties: { claim_stall: { type: 'boolean', description: 'true to claim a stall win instead of resigning' } }
        }
    }
];

async function callTool(name, args) {
    if (!KEY && name !== 'flux_rooms') {
        return 'No FLUX_KEY set. Register at https://fluxdots.com (Dashboard → Agents → Add Agent) and put the flxa_ key in the FLUX_KEY env var of this MCP server.';
    }
    switch (name) {
        case 'flux_me': {
            const { status, data } = await api('GET', '/me');
            if (status !== 200) return `error ${status}: ${JSON.stringify(data)}`;
            return JSON.stringify(data, null, 2);
        }
        case 'flux_rooms': {
            const [open, live] = await Promise.all([
                api('GET', '/rooms', null, false),
                api('GET', '/rooms?live=1', null, false)
            ]);
            const o = (open.data || []).map(r => `JOINABLE ${r.code} — host ${r.host?.name}${r.host?.agent_id ? ' [agent]' : ''}, ${r.board_size}x${r.board_size}`);
            const l = (live.data || []).map(r => `LIVE ${r.code} — ${(r.players || []).map(p => p.name).join(' vs ')}, move ${r.seq}`);
            return [...o, ...l].join('\n') || 'No rooms right now — host one with flux_host.';
        }
        case 'flux_host': {
            const { status, data } = await api('POST', '/rooms', { open: true, board_size: args.board_size || 7 });
            if (status !== 200) return `error ${status}: ${JSON.stringify(data)}`;
            seat = { code: data.code, token: data.seat_token, color: data.color };
            return `Hosting room ${data.code} as color ${data.color}. Poll flux_state until an opponent joins.`;
        }
        case 'flux_join': {
            const code = String(args.code || '').toUpperCase();
            const { status, data } = await api('POST', `/rooms/${code}/join`, {});
            if (status !== 200) return `error ${status}: ${JSON.stringify(data)}`;
            seat = { code, token: data.seat_token, color: data.color };
            return `Joined ${code} as color ${data.color}.\n\n` + roomSummary(data.room);
        }
        case 'flux_state': {
            const code = String(args.code || (seat && seat.code) || '').toUpperCase();
            if (!code) return 'Not seated in a room — flux_host or flux_join first.';
            const { status, data } = await api('GET', `/rooms/${code}/state?since=-1`, null, false);
            if (status !== 200) return `error ${status}: ${JSON.stringify(data)}`;
            return roomSummary(data);
        }
        case 'flux_move': {
            if (!seat) return 'Not seated in a room — flux_host or flux_join first.';
            const st = await api('GET', `/rooms/${seat.code}/state?since=-1`, null, false);
            const seq = st.data?.state?.seq ?? 0;
            const { status, data } = await api('POST', `/rooms/${seat.code}/move`, {
                seat_token: seat.token, seq,
                move: { fromR: args.fromR, fromC: args.fromC, r: args.r, c: args.c }
            });
            if (status !== 200) return `move rejected (${status}): ${JSON.stringify(data)}`;
            return 'Move made.\n\n' + roomSummary(data);
        }
        case 'flux_resign': {
            if (!seat) return 'Not seated in a room.';
            const { status, data } = await api('POST', `/rooms/${seat.code}/resign`,
                { seat_token: seat.token, ...(args.claim_stall ? { claim_stall: true } : {}) });
            const out = status === 200 ? 'Done.\n\n' + roomSummary(data) : `error ${status}: ${JSON.stringify(data)}`;
            seat = null;
            return out;
        }
        default:
            return `unknown tool ${name}`;
    }
}

// ---- newline-delimited JSON-RPC over stdio ----

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let req;
        try { req = JSON.parse(line); } catch (e) { continue; }
        handle(req);
    }
});

async function handle(req) {
    const { id, method, params } = req;
    if (method === 'initialize') {
        return send({
            jsonrpc: '2.0', id,
            result: {
                protocolVersion: params?.protocolVersion || '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'fluxdots', version: '1.0.0' }
            }
        });
    }
    if (method === 'notifications/initialized' || String(method).startsWith('notifications/')) return;
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') {
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    }
    if (method === 'tools/call') {
        try {
            const text = await callTool(params.name, params.arguments || {});
            return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
        } catch (e) {
            return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'error: ' + (e.message || e) }], isError: true } });
        }
    }
    if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
}
