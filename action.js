const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/** 发送 Telegram 通知：先发汇总消息，再逐个发送截图 */
async function sendTelegramNotification(results, screenshotDir = '.') {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        console.log('Telegram 未配置 (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)，跳过通知');
        return;
    }

    const baseUrl = `https://api.telegram.org/bot${token}`;

    // 1. 发送续期结果汇总
    const lines = ['🔔 *XServer 续期结果*\n'];
    for (const r of results) {
        const status = r.status === 'success' ? '✅ 成功' : r.status === 'skip' ? '⏭ 跳过' : '❌ 失败';
        let line = `• ${r.username}: ${status}`;
        if (r.message) line += ` (${r.message})`;
        lines.push(line);
    }
    const summary = lines.join('\n');

    try {
        const msgRes = await fetch(`${baseUrl}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: summary,
                parse_mode: 'Markdown',
            }),
        });
        if (!msgRes.ok) {
            const err = await msgRes.text();
            console.error('Telegram sendMessage 失败:', err);
            return;
        }

        // 2. 逐个发送截图（带简短说明）
        for (const r of results) {
            if (!r.screenshotPath || !fs.existsSync(r.screenshotPath)) continue;
            const caption = `${r.username} - ${r.status === 'success' ? '成功' : r.status === 'skip' ? '跳过' : '失败'}`;
            const formData = new FormData();
            formData.append('chat_id', chatId);
            formData.append('caption', caption);
            formData.append('photo', new Blob([fs.readFileSync(r.screenshotPath)]), path.basename(r.screenshotPath));

            const photoRes = await fetch(`${baseUrl}/sendPhoto`, {
                method: 'POST',
                body: formData,
            });
            if (!photoRes.ok) {
                console.error(`发送截图失败 ${r.screenshotPath}:`, await photoRes.text());
            }
        }
    } catch (err) {
        console.error('Telegram 通知异常:', err);
    }
}

(async () => {
    // Read users from environment variable
    let users = [];
    try {
        if (process.env.USERS_JSON) {
            users = JSON.parse(process.env.USERS_JSON);
            if (!Array.isArray(users)) {
                console.error('USERS_JSON must be an array of objects.');
                process.exit(1);
            }
        } else {
            console.log('USERS_JSON environment variable not found.');
            process.exit(1);
        }
    } catch (err) {
        console.error('Error parsing USERS_JSON:', err);
        process.exit(1);
    }

    const results = [];
    const browser = await chromium.launch({
        headless: true,
        channel: 'chrome',
    });

    for (const user of users) {
        console.log(`Processing user: ${user.username}`);
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
            // 1. Navigate to Login Page
            await page.goto('https://secure.xserver.ne.jp/xapanel/login/xmgame');

            // 2. Login
            await page.getByRole('textbox', { name: 'XServerアカウントID または メールアドレス' }).click();
            await page.getByRole('textbox', { name: 'XServerアカウントID または メールアドレス' }).fill(user.username);
            await page.locator('#user_password').fill(user.password);
            await page.getByRole('button', { name: 'ログインする' }).click();

            // Wait for navigation
            await page.getByRole('link', { name: 'ゲーム管理' }).click();
            await page.waitForLoadState('networkidle');

            // 3. Upgrade / Extension
            await page.getByRole('link', { name: 'アップグレード・期限延長' }).click();

            // 4. Select 'Extend Period' - Check if available
            try {
                await page.getByRole('link', { name: '期限を延長する' }).waitFor({ state: 'visible', timeout: 5000 });
                await page.getByRole('link', { name: '期限を延長する' }).click();
            } catch (e) {
                console.log(`'Extend Period' button not found for ${user.username}. Possibly unable to extend.`);
                const screenshotPath = `skip_${user.username}.png`;
                await page.screenshot({ path: screenshotPath });
                results.push({ username: user.username, status: 'skip', message: '无可延长期限', screenshotPath });
                continue;
            }

            // 5. Confirm
            await page.getByRole('button', { name: '確認画面に進む' }).click();

            // 6. Execute Extension
            console.log(`Clicking final extension button for ${user.username}...`);
            await page.getByRole('button', { name: '期限を延長する' }).click();

            // 7. Return
            await page.getByRole('link', { name: '戻る' }).click();

            console.log(`Successfully extended for ${user.username}`);
            const screenshotPath = `success_${user.username}.png`;
            await page.screenshot({ path: screenshotPath });
            results.push({ username: user.username, status: 'success', message: '已延长期限', screenshotPath });

        } catch (error) {
            console.error(`Failed for user ${user.username}:`, error);
            const screenshotPath = `error_${user.username}.png`;
            await page.screenshot({ path: screenshotPath }).catch(() => {});
            results.push({
                username: user.username,
                status: 'error',
                message: (error && error.message) ? error.message : String(error),
                screenshotPath,
            });
        } finally {
            await context.close();
        }
    }

    await browser.close();

    // 发送 Telegram 通知（汇总 + 截图）
    await sendTelegramNotification(results);
})();
