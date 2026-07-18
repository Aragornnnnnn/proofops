// 테스트에서 실제 SQL 마이그레이션 원문을 불러오는 모듈 선언
declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
