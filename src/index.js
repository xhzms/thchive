/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const axios = require('axios');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { URLSearchParams, URL } = require('url');
const multer = require('multer');
const { Client } = require('@notionhq/client');
const { saveThreadToNotion } = require('./notionService');

const app = express();
const upload = multer();

const DEFAULT_THREADS_QUERY_LIMIT = 10;

const FIELD__ALT_TEXT = 'alt_text';
const FIELD__ERROR_MESSAGE = 'error_message';
const FIELD__FOLLOWERS_COUNT = 'followers_count';
const FIELD__HIDE_STATUS = 'hide_status';
const FIELD__ID = 'id';
const FIELD__IS_REPLY = 'is_reply';
const FIELD__LIKES = 'likes';
const FIELD__LINK_ATTACHMENT_URL = 'link_attachment_url';
const FIELD__MEDIA_TYPE = 'media_type';
const FIELD__MEDIA_URL = 'media_url';
const FIELD__PERMALINK = 'permalink';
const FIELD__REPLIES = 'replies';
const FIELD__REPOSTS = 'reposts';
const FIELD__QUOTES = 'quotes';
const FIELD__REPLY_AUDIENCE = 'reply_audience';
const FIELD__STATUS = 'status';
const FIELD__TEXT = 'text';
const FIELD__TIMESTAMP = 'timestamp';
const FIELD__THREADS_BIOGRAPHY = 'threads_biography';
const FIELD__THREADS_PROFILE_PICTURE_URL = 'threads_profile_picture_url';
const FIELD__USERNAME = 'username';
const FIELD__VIEWS = 'views';

const MEDIA_TYPE__CAROUSEL = 'CAROUSEL';
const MEDIA_TYPE__IMAGE = 'IMAGE';
const MEDIA_TYPE__TEXT = 'TEXT';
const MEDIA_TYPE__VIDEO = 'VIDEO';

const PARAMS__ACCESS_TOKEN = 'access_token';
const PARAMS__ALT_TEXT = 'alt_text';
const PARAMS__CLIENT_ID = 'client_id';
const PARAMS__CONFIG = 'config';
const PARAMS__FIELDS = 'fields';
const PARAMS__HIDE = 'hide';
const PARAMS__LINK_ATTACHMENT = 'link_attachment';
const PARAMS__METRIC = 'metric';
const PARAMS__Q = 'q';
const PARAMS__QUOTA_USAGE = 'quota_usage';
const PARAMS__QUOTE_POST_ID = 'quote_post_id';
const PARAMS__REDIRECT_URI = 'redirect_uri';
const PARAMS__REPLY_CONFIG = 'reply_config';
const PARAMS__REPLY_CONTROL = 'reply_control';
const PARAMS__REPLY_QUOTA_USAGE = 'reply_quota_usage';
const PARAMS__REPLY_TO_ID = 'reply_to_id';
const PARAMS__RESPONSE_TYPE = 'response_type';
const PARAMS__RETURN_URL = 'return_url';
const PARAMS__SCOPE = 'scope';
const PARAMS__SEARCH_TYPE = 'search_type';
const PARAMS__TEXT = 'text';

// Read variables from environment
require('dotenv').config();
const {
    HOST,
    PORT,
    REDIRECT_URI,
    APP_ID,
    API_SECRET,
    GRAPH_API_VERSION,
    INITIAL_ACCESS_TOKEN,
    INITIAL_USER_ID,
    REJECT_UNAUTHORIZED,
} = process.env;

const agent = new https.Agent({
    rejectUnauthorized: REJECT_UNAUTHORIZED !== 'false',
});

const GRAPH_API_BASE_URL = 'https://graph.threads.net/' +
    (GRAPH_API_VERSION ? GRAPH_API_VERSION + '/' : '');
const AUTHORIZATION_BASE_URL = 'https://www.threads.net';

let initial_access_token = INITIAL_ACCESS_TOKEN;
let initial_user_id = INITIAL_USER_ID;

// Access scopes required for the token
const SCOPES = [
    'threads_basic',
    'threads_content_publish',
    'threads_manage_insights',
    'threads_manage_replies',
    'threads_read_replies',
    'threads_keyword_search',
    'threads_manage_mentions',
];

app.use(express.static('public'));
app.set('views', path.join(__dirname, '../views'));
app.set('view engine', 'pug');
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
    session({
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: true,
        cookie: {
            maxAge: 6000000,
        },
    })
);

// Middleware to ensure the user is logged in
const loggedInUserChecker = (req, res, next) => {
    if (req.session.access_token) {
        next();
    } else if (initial_access_token && initial_user_id) {
        useInitialAuthenticationValues(req);
        next();
    } else {
        const returnUrl = encodeURIComponent(req.originalUrl);
        res.redirect(`/?${PARAMS__RETURN_URL}=${returnUrl}`);
    }
};

app.get('/', async (req, res) => {
    if (!(req.session.access_token) &&
        (initial_access_token && initial_user_id)) {
        useInitialAuthenticationValues(req);
        res.redirect('/account');
    } else {
        res.render('index', {
            title: 'Index',
            returnUrl: req.query[PARAMS__RETURN_URL],
        });
    }
});

// Login route using OAuth
app.get('/login', (req, res) => {
    const url = buildGraphAPIURL('oauth/authorize', {
        [PARAMS__SCOPE]: SCOPES.join(','),
        [PARAMS__CLIENT_ID]: APP_ID,
        [PARAMS__REDIRECT_URI]: REDIRECT_URI,
        [PARAMS__RESPONSE_TYPE]: 'code',
    }, null, AUTHORIZATION_BASE_URL);

    res.redirect(url);
});

// Callback route for OAuth user token And reroute to '/pages'
app.get('/callback', async (req, res) => {
    const code = req.query.code;
    const uri = buildGraphAPIURL('oauth/access_token', {}, null, GRAPH_API_BASE_URL);

    try {
        const response = await axios.post(uri, new URLSearchParams({
            client_id: APP_ID,
            client_secret: API_SECRET,
            grant_type: 'authorization_code',
            redirect_uri: REDIRECT_URI,
            code,
        }).toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            httpsAgent: agent,
        });
        req.session.access_token = response.data.access_token;
        res.redirect('/account');
    } catch (err) {
        console.error(err?.response?.data);
        res.render('index', {
            error: `There was an error with the request: ${err}`,
        });
    }
});

app.get('/account', loggedInUserChecker, async (req, res) => {
    const getUserDetailsUrl = buildGraphAPIURL('me', {
        [PARAMS__FIELDS]: [
            FIELD__USERNAME,
            FIELD__THREADS_PROFILE_PICTURE_URL,
            FIELD__THREADS_BIOGRAPHY,
        ].join(','),
    }, req.session.access_token);

    let userDetails = {};
    try {
        const response = await axios.get(getUserDetailsUrl, { httpsAgent: agent });
        userDetails = response.data;

        // This value is not currently used but it may come handy in the future
        if (!req.session.user_id)
            req.session.user_id = response.data.id;

        userDetails.user_profile_url = `https://www.threads.net/@${userDetails.username}`;
    } catch (e) {
        console.error(e);
    }

    res.render('account', {
        title: 'Account',
        ...userDetails,
    });
});

app.get('/userInsights', loggedInUserChecker, async (req, res) => {
    const { since, until } = req.query;

    const params = {
        [PARAMS__METRIC]: [
            FIELD__VIEWS,
            FIELD__LIKES,
            FIELD__REPLIES,
            FIELD__QUOTES,
            FIELD__REPOSTS,
            FIELD__FOLLOWERS_COUNT,
        ].join(',')
    };
    if (since) {
        params.since = since;
    }
    if (until) {
        params.until = until;
    }

    const queryThreadUrl = buildGraphAPIURL(`me/threads_insights`, params, req.session.access_token);

    let data = [];
    try {
        const queryResponse = await axios.get(queryThreadUrl, { httpsAgent: agent });
        data = queryResponse.data;
    } catch (e) {
        console.error(e?.response?.data?.error?.message ?? e.message);
    }

    const metrics = data?.data ?? [];
    for (const index in metrics) {
        const metric = metrics[index];
        if (metric.name === FIELD__VIEWS) {
            // The "views" metric returns as a value for user insights
            getInsightsValue(metrics, index);
        }
        else {
            // All other metrics return as a total value
            getInsightsTotalValue(metrics, index);
        }
    }

    res.render('user_insights', {
        title: 'User Insights',
        metrics,
        since,
        until,
    });
});

app.get('/publishingLimit', loggedInUserChecker, async (req, res) => {
    const params = {
        [PARAMS__FIELDS]: [
            PARAMS__QUOTA_USAGE,
            PARAMS__CONFIG,
            PARAMS__REPLY_QUOTA_USAGE,
            PARAMS__REPLY_CONFIG
        ].join(','),
    };

    const publishingLimitUrl = buildGraphAPIURL(`me/threads_publishing_limit`, params, req.session.access_token);

    let data = [];
    try {
        const queryResponse = await axios.get(publishingLimitUrl, { httpsAgent: agent });
        data = queryResponse.data;
    } catch (e) {
        console.error(e?.response?.data?.error?.message ?? e.message);
    }

    data = data.data?.[0] ?? {};

    const quotaUsage = data[PARAMS__QUOTA_USAGE];
    const config = data[PARAMS__CONFIG];
    const replyQuotaUsage = data[PARAMS__REPLY_QUOTA_USAGE];
    const replyConfig = data[PARAMS__REPLY_CONFIG];

    res.render('publishing_limit', {
        title: 'Publishing Limit',
        quotaUsage,
        config,
        replyQuotaUsage,
        replyConfig,
    });
});

app.get('/upload', loggedInUserChecker, (req, res) => {
    const { replyToId, quotePostId } = req.query;
    const title = replyToId === undefined ? 'Upload' : 'Upload (Reply)';
    res.render('upload', {
        title,
        replyToId,
        quotePostId,
    });
});

app.post('/repost', upload.array(), async (req, res) => {
    const { repostId } = req.body;

    const repostThreadsUrl = buildGraphAPIURL(`${repostId}/repost`, {}, req.session.access_token);
    try {
        const repostResponse = await axios.post(repostThreadsUrl, {});
        const containerId = repostResponse.data.id;
        return res.redirect(`threads/${containerId}`);
    }
    catch (e) {
        console.error(e.message);
        return res.json({
            error: true,
            message: `Error during repost: ${e}`,
        });
    }
});

app.post('/upload', upload.array(), async (req, res) => {
    const { text, attachmentType, attachmentUrl, attachmentAltText, replyControl, replyToId, linkAttachment, quotePostId } = req.body;
    const params = {
        [PARAMS__TEXT]: text,
        [PARAMS__REPLY_CONTROL]: replyControl,
        [PARAMS__REPLY_TO_ID]: replyToId,
        [PARAMS__LINK_ATTACHMENT]: linkAttachment,
    };

    if (quotePostId) {
        params[PARAMS__QUOTE_POST_ID] = quotePostId;
    }

    // No attachments
    if (!attachmentType?.length) {
        params.media_type = MEDIA_TYPE__TEXT;
    }
    // Single attachment
    else if (attachmentType?.length === 1) {
        addAttachmentFields(params, attachmentType[0], attachmentUrl[0], attachmentAltText[0]);
    }
    // Multiple attachments
    else {
        params.media_type = MEDIA_TYPE__CAROUSEL;
        params.children = [];
        attachmentType.forEach((type, i) => {
            const child = {
                is_carousel_item: true,
            };
            addAttachmentFields(child, type, attachmentUrl[i], attachmentAltText[i]);
            params.children.push(child);
        });
    }

    if (params.media_type === MEDIA_TYPE__CAROUSEL) {
        const createChildPromises = params.children.map(child => (
            axios.post(
                buildGraphAPIURL(`me/threads`, child, req.session.access_token),
                {},
            )
        ));
        try {
            const createCarouselItemResponse = await Promise.all(createChildPromises);
            // Replace children with the IDs
            params.children = createCarouselItemResponse
                .filter(response => response.status === 200)
                .map(response => response.data.id)
                .join(',');
        } catch (e) {
            console.error(e.message);
            res.json({
                error: true,
                message: `Error creating child elements: ${e}`,
            });
            return;
        }
    }

    const postThreadsUrl = buildGraphAPIURL(`me/threads`, params, req.session.access_token);
    try {
        const postResponse = await axios.post(postThreadsUrl, {}, { httpsAgent: agent });
        const containerId = postResponse.data.id;
        res.json({
            id: containerId,
        });
    }
    catch (e) {
        console.error(e.message);
        res.json({
            error: true,
            message: `Error during upload: ${e}`,
        });
    }
});

app.get('/publish/:containerId', loggedInUserChecker, async (req, res) => {
    const containerId = req.params.containerId;
    res.render('publish', {
        containerId,
        title: 'Publish',
    });
});

app.get('/container/status/:containerId', loggedInUserChecker, async (req, res) => {
    const { containerId } = req.params;
    const getContainerStatusUrl = buildGraphAPIURL(containerId, {
        [PARAMS__FIELDS]: [
            FIELD__STATUS,
            FIELD__ERROR_MESSAGE
        ].join(','),
    }, req.session.access_token);

    try {
        const queryResponse = await axios.get(getContainerStatusUrl, { httpsAgent: agent });
        res.json(queryResponse.data);
    } catch (e) {
        console.error(e.message);
        res.json({
            error: true,
            message: `Error querying container status: ${e}`,
        });
    }
});

app.post('/publish', upload.array(), async (req, res) => {
    const { containerId } = req.body;
    const publishThreadsUrl = buildGraphAPIURL(`me/threads_publish`, {
        creation_id: containerId,
    }, req.session.access_token);

    try {
        const postResponse = await axios.post(publishThreadsUrl, { httpsAgent: agent });
        const threadId = postResponse.data.id;
        res.json({
            id: threadId,
        });
    }
    catch (e) {
        console.error(e.message);
        res.json({
            error: true,
            message: `Error during publishing: ${e}`,
        });
    }
});

app.get('/threads/:threadId', loggedInUserChecker, async (req, res) => {
    const { threadId } = req.params;
    let data = {};
    const queryThreadUrl = buildGraphAPIURL(`${threadId}`, {
        [PARAMS__FIELDS]: [
            FIELD__TEXT,
            FIELD__MEDIA_TYPE,
            FIELD__MEDIA_URL,
            FIELD__PERMALINK,
            FIELD__TIMESTAMP,
            FIELD__IS_REPLY,
            FIELD__USERNAME,
            FIELD__REPLY_AUDIENCE,
            FIELD__ALT_TEXT,
            FIELD__LINK_ATTACHMENT_URL,
        ].join(','),
    }, req.session.access_token);

    try {
        const queryResponse = await axios.get(queryThreadUrl, { httpsAgent: agent });
        data = queryResponse.data;
    } catch (e) {
        console.error(e?.response?.data?.error?.message ?? e.message);
    }

    res.render('thread', {
        threadId,
        ...data,
        title: 'Thread',
    });
});

app.get('/threads', loggedInUserChecker, async (req, res) => {
    const { before, after, limit } = req.query;
    const params = {
        [PARAMS__FIELDS]: [
            FIELD__TEXT,
            FIELD__MEDIA_TYPE,
            FIELD__MEDIA_URL,
            FIELD__PERMALINK,
            FIELD__TIMESTAMP,
            FIELD__REPLY_AUDIENCE,
            FIELD__ALT_TEXT,
        ].join(','),
        limit: limit ?? DEFAULT_THREADS_QUERY_LIMIT,
    };
    if (before) {
        params.before = before;
    }
    if (after) {
        params.after = after;
    }

    let threads = [];
    let paging = {};

    const queryThreadsUrl = buildGraphAPIURL(`me/threads`, params, req.session.access_token);

    try {
        const queryResponse = await axios.get(queryThreadsUrl, { httpsAgent: agent });
        threads = queryResponse.data.data;

        if (queryResponse.data.paging) {
            const { next, previous } = queryResponse.data.paging;

            if (next) {
                paging.nextUrl = getCursorUrlFromGraphApiPagingUrl(req, next);
            }

            if (previous) {
                paging.previousUrl = getCursorUrlFromGraphApiPagingUrl(req, previous);
            }
        }
    } catch (e) {
        console.error(e?.response?.data?.error?.message ?? e.message);
    }

    res.render('threads', {
        paging,
        threads,
        title: 'Threads',
    });
});

app.get('/replies', loggedInUserChecker, async (req, res) => {
    const { before, after, limit } = req.query;
    const params = {
        [PARAMS__FIELDS]: [
            FIELD__TEXT,
            FIELD__MEDIA_TYPE,
            FIELD__MEDIA_URL,
            FIELD__PERMALINK,
            FIELD__TIMESTAMP,
            FIELD__REPLY_AUDIENCE,
        ].join(','),
        limit: limit ?? DEFAULT_THREADS_QUERY_LIMIT,
    };
    if (before) {
        params.before = before;
    }
    if (after) {
        params.after = after;
    }

    let threads = [];
    let paging = {};

    const queryRepliesUrl = buildGraphAPIURL(`me/replies`, params, req.session.access_token);

    try {
        const queryResponse = await axios.get(queryRepliesUrl, { httpsAgent: agent });
        threads = queryResponse.data.data;

        if (queryResponse.data.paging) {
            const { next, previous } = queryResponse.data.paging;

            if (next) {
                paging.nextUrl = getCursorUrlFromGraphApiPagingUrl(req, next);
            }

            if (previous) {
                paging.previousUrl = getCursorUrlFromGraphApiPagingUrl(req, previous);
            }
        }
    } catch (e) {
        console.error(e?.response?.data?.error?.message ?? e.message);
    }

    res.render('threads', {
        paging,
        threads,
        title: 'My Replies',
    });
});

app.get('/threads/:threadId/replies', loggedInUserChecker, (req, res) => {
    showReplies(req, res, true);
});

app.get('/threads/:threadId/conversation', loggedInUserChecker, (req, res) => {
    showReplies(req, res, false);
});

app.post('/manage_reply/:replyId', upload.array(), async (req, res) => {
    const { replyId } = req.params;
    const { hide } = req.query;

    const params = {};
    if (hide) {
        params[PARAMS__HIDE] = hide === 'true';
    }

    const hideReplyUrl = buildGraphAPIURL(`${replyId}/manage_reply`, {}, req.session.access_token);

    try {
        response = await axios.post(hideReplyUrl, params, { httpsAgent: agent });
    }
    catch (e) {
        console.error(e?.message);
        return res.status(e?.response?.status ?? 500).json({
            error: true,
            message: `Error while hiding reply: ${e}`,
        });
    }

    return res.sendStatus(200);
});

app.get('/threads/:threadId/insights', loggedInUserChecker, async (req, res) => {
    const { threadId } = req.params;
    const { since, until } = req.query;

    const params = {
        [PARAMS__METRIC]: [
            FIELD__VIEWS,
            FIELD__LIKES,
            FIELD__REPLIES,
            FIELD__REPOSTS,
            FIELD__QUOTES,
        ].join(',')
    };
    if (since) {
        params.since = since;
    }
    if (until) {
        params.until = until;
    }

    const queryThreadUrl = buildGraphAPIURL(`${threadId}/insights`, params, req.session.access_token);

    let data = [];
    try {
        const queryResponse = await axios.get(queryThreadUrl, { httpsAgent: agent });
        data = queryResponse.data;
    } catch (e) {
        console.error(e?.response?.data?.error?.message ?? e.message);
    }

    const metrics = data?.data ?? [];
    for (const index in metrics) {
        // All metrics return as a value (rather than total value) for media insights
        getInsightsValue(metrics, index);
    }

    res.render('thread_insights', {
        title: 'Thread Insights',
        threadId,
        metrics,
        since,
        until,
    });
});

app.get('/mentions', loggedInUserChecker, async (req, res) => {
    const { before, after, limit } = req.query;
    const params = {
        [PARAMS__FIELDS]: [
            FIELD__USERNAME,
            FIELD__TEXT,
            FIELD__MEDIA_TYPE,
            FIELD__MEDIA_URL,
            FIELD__PERMALINK,
            FIELD__TIMESTAMP,
            FIELD__REPLY_AUDIENCE,
            FIELD__ALT_TEXT,
        ].join(','),
        limit: limit ?? DEFAULT_THREADS_QUERY_LIMIT,
    };
    if (before) {
        params.before = before;
    }
    if (after) {
        params.after = after;
    }

    const queryMentionsUrl = buildGraphAPIURL(`me/mentions`, params, req.session.access_token);

    let threads = [];
    let paging = {};

    try {
        const queryResponse = await axios.get(queryMentionsUrl, { httpsAgent: agent });
        threads = queryResponse.data.data;

        if (queryResponse.data.paging) {
            const { next, previous } = queryResponse.data.paging;

            if (next) {
                paging.nextUrl = getCursorUrlFromGraphApiPagingUrl(req, next);
            }

            if (previous) {
                paging.previousUrl = getCursorUrlFromGraphApiPagingUrl(req, previous);
            }
        }
    } catch (e) {
        console.error(e?.response?.data?.error?.message ?? e.message);
    }

    res.render('mentions', {
        title: 'Mentions',
        threads,
        paging,
    });
});

app.get('/keywordSearch', loggedInUserChecker, async (req, res) => {
    const { keyword, searchType } = req.query;

    if (!keyword) {
        return res.render('keyword_search', {
            title: 'Search for Threads',
        });
    }

    const params = {
        [PARAMS__Q]: keyword,
        [PARAMS__SEARCH_TYPE]: searchType,
        [PARAMS__FIELDS]: [
            FIELD__USERNAME,
            FIELD__ID,
            FIELD__TIMESTAMP,
            FIELD__MEDIA_TYPE,
            FIELD__TEXT,
            FIELD__PERMALINK,
            FIELD__REPLY_AUDIENCE,
        ].join(',')
    };

    const keywordSearchUrl = buildGraphAPIURL(`keyword_search`, params, req.session.access_token);

    let threads = [];
    let paging = {};

    try {
        const response = await axios.get(keywordSearchUrl, { httpsAgent: agent });
        threads = response.data.data;

        if (response.data.paging) {
            const { next, previous } = response.data.paging;

            if (next) {
                paging.nextUrl = getCursorUrlFromGraphApiPagingUrl(req, next);
            }
        }
    } catch (e) {
        console.error(e?.response?.data?.error?.message ?? e.message);
    }

    return res.render('keyword_search', {
        title: 'Search for Threads',
        threads,
        paging,
        resultsTitle: `${searchType} results for '${keyword}'`,
    });
});

// Logout route to kill the session
app.get('/logout', (req, res) => {
    if (req.session) {
        req.session.destroy((err) => {
            if (err) {
                res.render('index', { error: 'Unable to log out' });
            } else {
                res.render('index', { response: 'Logout successful!' });
            }
        });
    } else {
        res.render('index', { response: 'Token not stored in session' });
    }
});

app.get('/oEmbed', async (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.render('oembed', {
            title: 'Embed Threads',
        });
    }

    const oEmbedUrl = buildGraphAPIURL(`oembed`, {
        url,
    }, `TH|${APP_ID}|${API_SECRET}`);

    let html = '<p>Unable to embed</p>';
    try {
        const response = await axios.get(oEmbedUrl, { httpsAgent: agent });
        if (response.data?.html) {
            html = response.data.html;
        }
    } catch (e) {
        console.error(e?.response?.data?.error?.message ?? e.message);
    }

    return res.render('oembed', {
        title: 'Embed Threads',
        html,
        url,
    });
});

// 모든 스레드를 가져오는 함수
async function fetchAllThreads(accessToken) {
    let allThreads = [];
    let nextCursor = null;
    let pageCount = 0;
    
    do {
        const params = {
            [PARAMS__FIELDS]: [
                'id',
                'media_product_type',
                'media_type',
                'media_url',
                'permalink',
                'owner',
                'username',
                'text',
                'timestamp',
                'shortcode',
                'thumbnail_url',
                'children{media_type,media_url,alt_text,thumbnail_url}',
                'is_quote_post',
                'quoted_post{id,permalink,text,media_type,media_url,username,owner,shortcode,thumbnail_url,alt_text,children{media_type,media_url,alt_text,thumbnail_url}}',
                'reposted_post{id,username,shortcode,permalink}',
                'alt_text',
                'link_attachment_url',
                'gif_url'
            ].join(','),
            limit: DEFAULT_THREADS_QUERY_LIMIT
        };

        if (nextCursor) {
            params.after = nextCursor;
        }

        pageCount++;
        console.log(`${pageCount}번째 페이지 로딩 중... (현재 ${allThreads.length}개 로드됨)`);
        
        const queryThreadsUrl = buildGraphAPIURL(`me/threads`, params, accessToken);
        const queryResponse = await axios.get(queryThreadsUrl, { httpsAgent: agent });
        
        const newThreads = queryResponse.data.data;
        
        // 인사이트 정보 병렬로 가져오기
        const insightPromises = newThreads.map(thread => 
            fetchThreadWithInsights(thread.id, accessToken)
                .then(insights => {
                    thread.insights = insights;
                    if (thread.media_type === 'CAROUSEL_ALBUM' && thread.children) {
                        thread.children = {
                            data: thread.children.data || []
                        };
                    }
                    // 인용된 글의 URL이 없는 경우 생성
                    if (thread.is_quote_post && thread.quoted_post) {
                        if (!thread.quoted_post.permalink && thread.quoted_post.username && thread.quoted_post.shortcode) {
                            thread.quoted_post.permalink = `https://www.threads.net/@${thread.quoted_post.username}/post/${thread.quoted_post.shortcode}`;
                        }
                        // 인용된 글이 캐러셀인 경우 처리
                        if (thread.quoted_post.media_type === 'CAROUSEL_ALBUM' && thread.quoted_post.children) {
                            thread.quoted_post.children = {
                                data: thread.quoted_post.children.data || []
                            };
                        }
                    }
                    return thread;
                })
        );

        const processedThreads = await Promise.all(insightPromises);
        allThreads = [...allThreads, ...processedThreads];

        nextCursor = queryResponse.data.paging?.next ? 
            new URL(queryResponse.data.paging.next).searchParams.get('after') : 
            null;

        if (pageCount >= 10) {
            console.log(`${pageCount}페이지 로드 완료, 중단합니다.`);
            break;
        }

        if (nextCursor) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

    } while (nextCursor);

    return allThreads;
}

// 게시물 필터링 함수 추가
function filterThreads(threads) {
    return threads.filter(thread => thread.media_type !== 'REPOST_FACADE');
}

// 새로운 라우트 추가
app.get('/threads_all', loggedInUserChecker, async (req, res) => {
    try {
        const allThreads = await fetchAllThreads(req.session.access_token);
        console.log(`총 ${allThreads.length}개의 스레드를 불러왔습니다.`);
        
        res.render('threads', {
            threads: allThreads,
            paging: {}, // 페이징 없음
            title: `전체 Threads (${allThreads.length}개)`
        });
    } catch (e) {
        console.error('전체 스레드 로딩 중 에러:', e?.response?.data?.error?.message ?? e.message);
        res.render('threads', {
            error: '스레드를 불러오는 중 오류가 발생했습니다.',
            threads: [],
            paging: {},
            title: 'Threads - Error'
        });
    }
});

// 답글 체인을 가져오는 함수
async function fetchReplyChain(threadId, accessToken, username) {
    const params = {
        [PARAMS__FIELDS]: [
            FIELD__ID,
            FIELD__TEXT,
            FIELD__MEDIA_TYPE,
            FIELD__MEDIA_URL,
            FIELD__PERMALINK,
            FIELD__TIMESTAMP,
            FIELD__USERNAME,
            FIELD__REPLY_AUDIENCE,
        ].join(',')
    };

    const queryRepliesUrl = buildGraphAPIURL(`${threadId}/replies`, params, accessToken);
    
    try {
        const response = await axios.get(queryRepliesUrl, { httpsAgent: agent });
        const replies = response.data.data;
        let myReplyChain = [];

        // 각 답글 확인
        for (const reply of replies) {
            // 내가 작성한 답글인 경우
            if (reply.username === username) {
                // insights 정보 가져오기
                const insights = await fetchThreadWithInsights(reply.id, accessToken);
                reply.insights = insights;
                
                // 이 답글에 달린 답글들도 재귀적으로 확인
                const childReplies = await fetchReplyChain(reply.id, accessToken, username);
                
                myReplyChain.push({
                    ...reply,
                    childReplies
                });
            }
        }

        return myReplyChain;
    } catch (e) {
        console.error(`답글 체인 로드 실패 (Thread ${threadId}):`, e.message);
        return [];
    }
}

// 새로운 라우트 추가
app.get('/threads_with_replies', loggedInUserChecker, async (req, res) => {
    try {
        // 1. 먼저 내 게시물들 가져오기
        const threads = await fetchAllThreads(req.session.access_token);
        
        // 2. 각 게시물의 답글 체인 가져오기
        for (const thread of threads) {
            // 사용자 정보 가져오기 (첫 번째 게시물에서만)
            if (!req.session.username) {
                const userInfoUrl = buildGraphAPIURL('me', {
                    [PARAMS__FIELDS]: FIELD__USERNAME
                }, req.session.access_token);
                const userResponse = await axios.get(userInfoUrl, { httpsAgent: agent });
                req.session.username = userResponse.data.username;
            }

            // 답글 체인 가져오기
            thread.replyChain = await fetchReplyChain(
                thread.id, 
                req.session.access_token,
                req.session.username
            );
            
            // 2초 대기
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // 3. 결과 렌더링
        res.render('threads_with_replies', {
            threads: threads,
            title: `Threads with Reply Chains (${threads.length}개)`
        });
    } catch (e) {
        console.error('Error:', e);
        res.status(500).json({
            error: true,
            message: '데이터 로드 중 오류가 발생했습니다.'
        });
    }
});

app.get('/threads_all_with_replies', loggedInUserChecker, async (req, res) => {
    try {
        console.log('사용자 정보 가져오는 중...');
        const userInfoUrl = buildGraphAPIURL('me', {
            [PARAMS__FIELDS]: FIELD__USERNAME
        }, req.session.access_token);
        const userResponse = await axios.get(userInfoUrl, { httpsAgent: agent });
        const username = userResponse.data.username;
        console.log('사용자:', username);

        console.log('게시물 로드 시작...');
        let threads = await fetchAllThreads(req.session.access_token);
        console.log(`${threads.length}개의 게시물 로드 완료`);

        // REPOST 필터링
        threads = filterThreads(threads);
        console.log(`리포스트 제외 후 ${threads.length}개의 게시물 처리 시작`);

        // 답글 체인 병렬 수집 - 배치 크기 증가
        console.log('답글 체인 수집 시작...');
        const batchSize = 20; // 10에서 20으로 증가
        for (let i = 0; i < threads.length; i += batchSize) {
            const batch = threads.slice(i, i + batchSize);
            const promises = batch.map(thread => 
                fetchReplyChain(thread.id, req.session.access_token, username)
                    .then(replyChain => {
                        thread.replyChain = replyChain;
                        console.log(`- 게시물 ${i + batch.indexOf(thread) + 1}/${threads.length} 답글 체인 수집 완료`);
                    })
            );
            
            await Promise.all(promises);
            
            // 배치 사이 대기 시간 감소
            if (i + batchSize < threads.length) {
                await new Promise(resolve => setTimeout(resolve, 250)); // 500ms에서 250ms로 감소
            }
        }

        console.log('모든 데이터 수집 완료, 페이지 렌더링 시작');

        res.render('threads_with_replies', {
            threads: threads,
            title: `Threads with Reply Chains (${threads.length}개)`
        });
    } catch (e) {
        console.error('Error:', e);
        res.status(500).json({
            error: true,
            message: '데이터 로드 중 오류가 발생했습니다: ' + e.message
        });
    }
});

// Notion 저장을 위한 새로운 라우트 추가
app.post('/save-to-notion', loggedInUserChecker, async (req, res) => {
    try {
        const { threads } = req.body;
        console.log('Notion 데이터베이스에 저장 시작...');
        
        for (const thread of threads) {
            await saveThreadToNotion(thread);
            // API 제한을 고려한 대기
            await new Promise(resolve => setTimeout(resolve, 350));  // Notion API 제한: 3 요청/초
        }
        
        console.log('Notion 저장 완료');
        res.json({ success: true, message: 'Notion에 성공적으로 저장되었습니다.' });
    } catch (error) {
        console.error('Notion 저장 중 오류:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Notion 저장 중 오류가 발생했습니다: ' + error.message 
        });
    }
});

https
    .createServer({
        key: fs.readFileSync(path.join(__dirname, '../'+ HOST +'-key.pem')),
        cert: fs.readFileSync(path.join(__dirname, '../'+ HOST +'.pem')),
    }, app)
    .listen(PORT, HOST, (err) => {
        if (err) {
            console.error(`Error: ${err}`);
        }
        console.log(`listening on port ${PORT}!`);
    });

/**
 * @param {string} path
 * @param {URLSearchParams} searchParams
 * @param {string} accessToken
 * @param {string} base_url
 */
function buildGraphAPIURL(path, searchParams, accessToken, base_url) {
    const url = new URL(path, base_url ?? GRAPH_API_BASE_URL);

    url.search = new URLSearchParams(searchParams);
    if (accessToken) {
        url.searchParams.append(PARAMS__ACCESS_TOKEN, accessToken);
    }

    return url.toString();
}
/**
 * @param {Request} req
 */
function useInitialAuthenticationValues(req) {
    // Use initial values
    req.session.access_token = initial_access_token;
    req.session.user_id = initial_user_id;
    // Clear initial values to enable signing out
    initial_access_token = undefined;
    initial_user_id = undefined;
}

/**
 * @param {{ value?: number, values: { value: number }[] }[]} metrics
 * @param {*} index
 */
function getInsightsValue(metrics, index) {
    if (metrics[index]) {
        metrics[index].value = metrics[index].values?.[0]?.value;
    }
}

/**
 * @param {{ value?: number, total_value: { value: number } }[]} metrics
 * @param {number} index
 */
function getInsightsTotalValue(metrics, index) {
    if (metrics[index]) {
        metrics[index].value = metrics[index].total_value?.value;
    }
}

/**
 * @param {object} target
 * @param {string} attachmentType
 * @param {string} url
 */
function addAttachmentFields(target, attachmentType, url, altText) {
    if (attachmentType === 'Image') {
        target.media_type = MEDIA_TYPE__IMAGE;
        target.image_url = url;
        target.alt_text = altText;
    } else if (attachmentType === 'Video') {
        target.media_type = MEDIA_TYPE__VIDEO;
        target.video_url = url;
        target.alt_text = altText;
    }
}

/**
 * @param {URL} sourceUrl
 * @param {URL} destinationUrl
 * @param {string} paramName
 */
function setUrlParamIfPresent(sourceUrl, destinationUrl, paramName) {
    const paramValue = sourceUrl.searchParams.get(paramName);
    if (paramValue) {
        destinationUrl.searchParams.set(paramName, paramValue);
    }
}

/**
 * @param {Request} req
 * @param {string} graphApiPagingUrl
 */
function getCursorUrlFromGraphApiPagingUrl(req, graphApiPagingUrl) {
    const graphUrl = new URL(graphApiPagingUrl);

    const cursorUrl = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
    cursorUrl.search = '';

    setUrlParamIfPresent(graphUrl, cursorUrl, 'limit');
    setUrlParamIfPresent(graphUrl, cursorUrl, 'before');
    setUrlParamIfPresent(graphUrl, cursorUrl, 'after');

    return cursorUrl.href;
}

/**
 * @param {Request} req
 * @param {Response} res
 * @param {boolean} [isTopLevel]
 */
async function showReplies(req, res, isTopLevel) {
    const { threadId } = req.params;
    const { username, before, after, limit } = req.query;

    const params = {
        [PARAMS__FIELDS]: [
            FIELD__TEXT,
            FIELD__MEDIA_TYPE,
            FIELD__MEDIA_URL,
            FIELD__PERMALINK,
            FIELD__TIMESTAMP,
            FIELD__USERNAME,
            FIELD__HIDE_STATUS,
            FIELD__ALT_TEXT,
        ].join(','),
        limit: limit ?? DEFAULT_THREADS_QUERY_LIMIT,
    };
    if (before) {
        params.before = before;
    }
    if (after) {
        params.after = after;
    }

    let replies = [];
    let paging = {};

    const repliesOrConversation = isTopLevel ? 'replies' : 'conversation';
    const queryThreadsUrl = buildGraphAPIURL(`${threadId}/${repliesOrConversation}`, params, req.session.access_token);

    try {
        const queryResponse = await axios.get(queryThreadsUrl, { httpsAgent: agent });
        replies = queryResponse.data.data;

        if (queryResponse.data.paging) {
            const { next, previous } = queryResponse.data.paging;

            if (next)
                paging.nextUrl = getCursorUrlFromGraphApiPagingUrl(req, next);

            if (previous)
                paging.previousUrl = getCursorUrlFromGraphApiPagingUrl(req, previous);
        }
    } catch (e) {
        console.error(e?.response?.data?.error?.message ?? e.message);
    }

    res.render(isTopLevel ? 'thread_replies' : 'thread_conversation', {
        threadId,
        username,
        paging,
        replies,
        manage: isTopLevel ? true : false,
        title: 'Replies',
    });
}

async function fetchThreadWithInsights(threadId, accessToken) {
    const params = {
        [PARAMS__METRIC]: [
            FIELD__VIEWS,
            FIELD__LIKES,
            FIELD__REPLIES,
            FIELD__REPOSTS,
            FIELD__QUOTES,
        ].join(',')
    };

    const queryThreadUrl = buildGraphAPIURL(`${threadId}/insights`, params, accessToken);
    
    try {
        const queryResponse = await axios.get(queryThreadUrl, { httpsAgent: agent });
        const metrics = queryResponse.data?.data ?? [];
        
        // 메트릭 데이터를 객체로 변환
        const insights = {};
        metrics.forEach(metric => {
            insights[metric.name] = metric.values?.[0]?.value ?? 0;
        });
        
        return insights;
    } catch (e) {
        console.error(`Thread ${threadId} insights 로드 실패:`, e.message);
        return {
            views: 0,
            likes: 0,
            replies: 0,
            reposts: 0,
            quotes: 0
        };
    }
}