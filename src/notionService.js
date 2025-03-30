const { Client } = require('@notionhq/client');

const notion = new Client({
    auth: process.env.NOTION_TOKEN,
});

const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Notion에 Thread 데이터 저장하는 함수
async function saveThreadToNotion(thread) {
    try {
        return await notion.pages.create({
            parent: { database_id: NOTION_DATABASE_ID },
            properties: {
                ID: {
                    title: [{ text: { content: thread.id } }]
                },
                "Created At": {
                    date: { start: thread.timestamp }
                },
                "Media Type": {
                    select: { name: thread.media_type }
                },
                "Content": {
                    rich_text: [{ text: { content: thread.text || '' } }]
                },
                "Views": {
                    number: thread.insights?.views || 0
                },
                "Likes": {
                    number: thread.insights?.likes || 0
                },
                "Replies": {
                    number: thread.insights?.replies || 0
                },
                "Reposts": {
                    number: thread.insights?.reposts || 0
                },
                "Thread URL": {
                    url: thread.permalink
                },
                "Media URLs": {
                    rich_text: [{
                        text: {
                            content: thread.media_type === 'CAROUSEL_ALBUM' 
                                ? thread.children?.data?.map(child => child.media_url).join('\n') || ''
                                : thread.media_url || ''
                        }
                    }]
                }
            }
        });
    } catch (error) {
        console.error(`Error saving thread ${thread.id} to Notion:`, error);
        throw error;
    }
}

module.exports = {
    saveThreadToNotion
}; 