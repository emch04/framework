import styles from './Notice.module.css';

export default function Notice({ tone = 'neutral', children }) {
  if (!children) return null;
  return <div className={`${styles.notice} ${styles[tone]}`}>{children}</div>;
}
