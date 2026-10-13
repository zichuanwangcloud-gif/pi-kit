import { t } from "../i18n";

/**
 * 登录表单。按钮没有 max-width / 文本溢出处理，
 * 德语等长文案语言下按钮会被撑变形、文字被裁掉。
 */
export function LoginForm({ onSubmit }: { onSubmit: () => void }) {
	return (
		<form onSubmit={onSubmit}>
			<button className="btn-login" onClick={onSubmit}>
				{t("login.submit")}
			</button>
		</form>
	);
}
