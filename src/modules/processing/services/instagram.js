import { createStream } from "../../stream/manage.js";
import { genericUserAgent } from "../../config.js";
import { getCookie, updateCookie } from "../cookie/manager.js";

const commonInstagramHeaders = {
    'user-agent': genericUserAgent,
    'sec-gpc': '1',
    'sec-fetch-site': 'same-origin',
    'x-ig-app-id': '936619743392459'
}

const cachedDtsg = {
    value: '',
    expiry: 0
}

async function findDtsgId(cookie) {
    try {
        if (cachedDtsg.expiry > Date.now()) return cachedDtsg.value;

        const data = await fetch('https://www.instagram.com/', {
            headers: {
                ...commonInstagramHeaders,
                cookie
            }
        }).then(r => r.text());

        const token = data.match(/"dtsg":{"token":"(.*?)"/)[1];

        cachedDtsg.value = token;
        cachedDtsg.expiry = Date.now() + 86390000;

        if (token) return token;
        return false;
    }
    catch {}
}

async function request(url, cookie, method = 'GET', requestData) {
    let headers = {
        ...commonInstagramHeaders,
        'x-ig-www-claim': cookie?._wwwClaim || '0',
        'x-csrftoken': cookie?.values()?.csrftoken,
        cookie
    }
    if (method === 'POST') {
        headers['content-type'] = 'application/x-www-form-urlencoded';
    }

    const data = await fetch(url, {
        method,
        headers,
        body: requestData && new URLSearchParams(requestData),
    });

    if (data.headers.get('X-Ig-Set-Www-Claim') && cookie)
        cookie._wwwClaim = data.headers.get('X-Ig-Set-Www-Claim');

    updateCookie(cookie, data.headers);
    return data.json();
}

async function requestHTML(id, cookie) {
    const data = await fetch(`https://www.instagram.com/p/${id}/embed/captioned/`, {
        headers: {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "Accept-Language": "en-GB,en;q=0.9",
            "Cache-Control": "max-age=0",
            "Dnt": "1",
            "Priority": "u=0, i",
            "Sec-Ch-Ua": 'Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": "macOS",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Upgrade-Insecure-Requests": "1",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            ...cookie
        }
    }).then(r => r.text());

    let embedData = JSON.parse(data?.match(/"init",\[\],\[(.*?)\]\],/)[1]);

    if (!embedData || !embedData?.contextJSON) return false;

    embedData = JSON.parse(embedData.contextJSON);

    return embedData;
}
async function requestGQL(id, cookie) {
    let dtsgId;

    if (cookie) {
        dtsgId = await findDtsgId(cookie);
    }
    const url = new URL('https://www.instagram.com/api/graphql/');

    const requestData = {
        jazoest: '26406',
        variables: JSON.stringify({
          shortcode: id,
          __relay_internal__pv__PolarisShareMenurelayprovider: false
        }),
        doc_id: '7153618348081770'
    };
    if (dtsgId) {
        requestData.fb_dtsg = dtsgId;
    }

    return (await request(url, cookie, 'POST', requestData))
            .data
            ?.xdt_api__v1__media__shortcode__web_info
            ?.items
            ?.[0];
}

function extractOldPost(data, id) {
    const sidecar = data?.gql_data?.shortcode_media?.edge_sidecar_to_children;
    if (sidecar) {
        const picker = sidecar.edges.filter(e => e.node?.display_url)
            .map(e => {
                const type = e.node?.is_video ? "video" : "photo";
                const url = type === "video" ? e.node?.video_url : e.node?.display_url;

                return {
                    type, url,
                    /* thumbnails have `Cross-Origin-Resource-Policy`
                    ** set to `same-origin`, so we need to proxy them */
                    thumb: createStream({
                        service: "instagram",
                        type: "default",
                        u: e.node?.display_url,
                        filename: "image.jpg"
                    })
                }
            });

        if (picker.length) return { picker }
    } else if (data?.gql_data?.shortcode_media?.video_url) {
        return {
            urls: data.gql_data.shortcode_media.video_url,
            filename: `instagram_${id}.mp4`,
            audioFilename: `instagram_${id}_audio`
        }
    } else if (data?.gql_data?.shortcode_media?.display_url) {
        return {
            urls: data.gql_data?.shortcode_media.display_url,
            isPhoto: true
        }
    }
}

function extractNewPost(data, id) {
    const carousel = data.carousel_media;
    if (carousel) {
        const picker = carousel.filter(e => e?.image_versions2)
            .map(e => {
                const type = e.video_versions ? "video" : "photo";
                const imageUrl = e.image_versions2.candidates[0].url;
                
                let url = imageUrl;
                if (type === 'video') {
                    const video = e.video_versions.reduce((a, b) => a.width * a.height < b.width * b.height ? b : a);
                    url = video.url;
                }

                return {
                    type, url,
                    /* thumbnails have `Cross-Origin-Resource-Policy`
                    ** set to `same-origin`, so we need to proxy them */
                    thumb: createStream({
                        service: "instagram",
                        type: "default",
                        u: imageUrl,
                        filename: "image.jpg"
                    })
                }
            });

        if (picker.length) return { picker }
    } else if (data.video_versions) {
        const video = data.video_versions.reduce((a, b) => a.width * a.height < b.width * b.height ? b : a)
        return {
            urls: video.url,
            filename: `instagram_${id}.mp4`,
            audioFilename: `instagram_${id}_audio`
        }
    } else if (data.image_versions2?.candidates) {
        return {
            urls: data.image_versions2.candidates[0].url,
            isPhoto: true
        }
    }
}

async function getPost(id) {
    let data, result, dataType = 'old';
    try {
        const cookie = getCookie('instagram');

        data = await requestHTML(id);
        if (!data && cookie) data = await requestHTML(id, cookie);

        if (!data) {
            dataType = 'new';
            data = await requestGQL(id, cookie);
        }
    } catch {}

    if (!data) return { error: 'ErrorCouldntFetch' };

    if (dataType === 'new') {
        result = extractNewPost(data, id)
    } else {
        result = extractOldPost(data, id)
    }

    if (result) return result;
    return { error: 'ErrorEmptyDownload' }
}

async function usernameToId(username, cookie) {
    const url = new URL('https://www.instagram.com/api/v1/users/web_profile_info/');
        url.searchParams.set('username', username);

    try {
        const data = await request(url, cookie);
        return data?.data?.user?.id;
    } catch {}
}

async function getStory(username, id) {
    const cookie = getCookie('instagram');
    if (!cookie) return { error: 'ErrorUnsupported' };

    const userId = await usernameToId(username, cookie);
    if (!userId) return { error: 'ErrorEmptyDownload' };
    
    const dtsgId = await findDtsgId(cookie);

    const url = new URL('https://www.instagram.com/api/graphql/');
    const requestData = {
        fb_dtsg: dtsgId,
        jazoest: '26438',
        variables: JSON.stringify({
            reel_ids_arr : [ userId ],
        }),
        server_timestamps: true,
        doc_id: '25317500907894419'
    };

    let media;
    try {
        const data = (await request(url, cookie, 'POST', requestData));
        media = data?.data?.xdt_api__v1__feed__reels_media?.reels_media?.find(m => m.id === userId);
    } catch {}

    const item = media.items.find(m => m.pk === id);
    if (!item) return { error: 'ErrorEmptyDownload' };
    
    if (item.video_versions) {
        const video = item.video_versions.reduce((a, b) => a.width * a.height < b.width * b.height ? b : a)
        return {
            urls: video.url,
            filename: `instagram_${id}.mp4`,
            audioFilename: `instagram_${id}_audio`
        }
    }

    if (item.image_versions2?.candidates) {
        return {
            urls: item.image_versions2.candidates[0].url,
            isPhoto: true
        }
    }

    return { error: 'ErrorCouldntFetch' };
}

export default function(obj) {
    const { postId, storyId, username } = obj;
    if (postId) return getPost(postId);
    if (username && storyId) return getStory(username, storyId);

    return { error: 'ErrorUnsupported' }
}
