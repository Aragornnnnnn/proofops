// 테스트에서 YAML 원문을 문자열 모듈로 가져오게 선언한다
declare module "*.yml?raw" {
  const content: string;
  export default content;
}
