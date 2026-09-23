const bili = require('./net/bili');
const { log } = require('./utils');

async function account() {
    const my_info = await bili.getMyinfo();
    const stat = await bili.getStat();
    const safe_info = await bili.getAccountSafeInfo();
    if (my_info && stat) {
        log.info('帐号信息', `${my_info.name} Lv${my_info.level} ${my_info.silence ? '已封禁' : '未封禁'} 升级还需${my_info.level_exp.next_exp - my_info.level_exp.current_exp}经验`);
        log.info('帐号信息', `当前关注数:${stat.following} 粉丝数:${stat.follower} 动态数量:${stat.dynamic_count}`);
    } else {
        log.error('帐号信息', '获取失败');
    }
    if (safe_info) {
        const tel = safe_info.bind_tel ? `${safe_info.hide_tel} (${safe_info.tel_verify ? '已验证' : '未验证'})` : '手机未绑定';
        const mail = safe_info.bind_mail ? `${safe_info.hide_mail} (${safe_info.mail_verify ? '已验证' : '未验证'})` : '邮箱未绑定';
        const realname = safe_info.realname_certified ? '已认证' : '未认证';
        log.info('帐号信息', `手机: ${tel}  邮箱: ${mail}  实名: ${realname}`);
    }
}

module.exports = { account };
