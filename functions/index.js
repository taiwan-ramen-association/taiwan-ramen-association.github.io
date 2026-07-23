const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { initializeApp }     = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging }      = require('firebase-admin/messaging');

initializeApp();

exports.notifyOnIssueReport = onDocumentCreated(
  'issueReports/{reportId}',
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    // 讀取所有 admin 的 FCM token
    const snapshot = await getFirestore()
      .collection('users')
      .where('role', '==', 'admin')
      .get();

    // 建立 token → { uid, isPrimary } 的映射，方便之後清除失效 token
    const tokenMeta = new Map(); // token string → { uid, isPrimary }
    snapshot.docs.forEach(d => {
      const uid  = d.id;
      const doc  = d.data();
      const arr  = doc.fcmTokens;

      if (Array.isArray(arr) && arr.length) {
        arr.forEach(t => {
          if (t) tokenMeta.set(t, { uid, isPrimary: t === doc.fcmToken });
        });
      } else if (doc.fcmToken) {
        tokenMeta.set(doc.fcmToken, { uid, isPrimary: true });
      }
    });

    const tokens = [...new Set(tokenMeta.keys())];

    if (!tokens.length) {
      console.log('找不到 admin FCM token，略過推播');
      return;
    }

    const shopName = data.shopName || data.shopId || '未知店家';
    const category = data.category || '問題回報';
    const note     = data.note     || '';
    const reporter = data.displayName || data.email || '匿名';

    const message = {
      tokens,
      notification: {
        title: `📝 新問題回報：${shopName}`,
        body:  `${category}${note ? '　' + note.slice(0, 50) : ''}　— ${reporter}`,
      },
      webpush: {
        notification: {
          icon:  'https://www.taiwanramen.org/assets/icons/03.png',
          badge: 'https://www.taiwanramen.org/assets/icons/03.png',
          tag:   'issue-report',
          requireInteraction: false,
        },
        fcmOptions: {
          link: 'https://www.taiwanramen.org/admin.html',
        },
      },
    };

    try {
      const response = await getMessaging().sendEachForMulticast(message);
      console.log(`推播結果：成功 ${response.successCount} / 失敗 ${response.failureCount}`);

      // 清除失效的 token：用 token 值（而非 index）找到對應 doc
      const INVALID_CODES = new Set([
        'messaging/registration-token-not-registered',
        'messaging/invalid-registration-token',
      ]);

      const updates = new Map(); // uid → { arrayRemoveTokens[], nullPrimary }
      response.responses.forEach((res, i) => {
        if (!res.success && INVALID_CODES.has(res.error?.code)) {
          const token = tokens[i];
          const meta  = tokenMeta.get(token);
          if (!meta) return;
          const { uid, isPrimary } = meta;
          if (!updates.has(uid)) updates.set(uid, { removeTokens: [], nullPrimary: false });
          updates.get(uid).removeTokens.push(token);
          if (isPrimary) updates.get(uid).nullPrimary = true;
        }
      });

      await Promise.all(
        [...updates.entries()].map(([uid, { removeTokens, nullPrimary }]) => {
          const patch = { fcmTokens: FieldValue.arrayRemove(...removeTokens) };
          if (nullPrimary) patch.fcmToken = null;
          return getFirestore().collection('users').doc(uid).update(patch);
        })
      );

      if (updates.size) {
        console.log(`已清除失效 token：${[...updates.keys()].join(', ')}`);
      }
    } catch (e) {
      console.error('推播失敗：', e);
    }
  }
);
