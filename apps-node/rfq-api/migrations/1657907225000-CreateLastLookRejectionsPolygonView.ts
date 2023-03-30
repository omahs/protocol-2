import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLastLookRejectionsPolygonView1657907225000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        // TypeORM does not have a 'nice' way to create VIEWs, so we have to use a regular SQL Query
        await queryRunner.query(`
          CREATE VIEW public.fast_last_look_rejections_polygon AS (
              SELECT
                  jobs.order_hash AS "orderHash",
                  quotes.created_at AS "quoteIssuedAt",
                  extract(epoch from jobs.created_at - quotes.created_at) AS "quoteOutstandingSeconds",
                  CASE
                      WHEN (taker_token = '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270') THEN (taker_amount / 1e18)
                      WHEN (maker_token = '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270') THEN (maker_amount / 1e18)
                      ELSE null
                  END AS "volumeMATIC",
                  CASE
                      -- DAI
                      WHEN (taker_token = '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063') THEN (taker_amount / 1e18)
                      WHEN (maker_token = '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063') THEN (maker_amount / 1e18)
                      -- USDC
                      WHEN (taker_token = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174') THEN (taker_amount / 1e6)
                      WHEN (maker_token = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174') THEN (maker_amount / 1e6)
                      -- USDT
                      WHEN (taker_token = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f') THEN (taker_amount / 1e6)
                      WHEN (maker_token = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f') THEN (maker_amount / 1e6)
                      ELSE null
                  END AS "volumeUSD",
                  taker as "takerAddress",
                  taker_token AS "takerToken",
                  taker_amount AS "takerAmount",
                  maker_token AS "makerToken",
                  maker_amount AS "makerAmount",
                  ll_reject_price_difference_bps AS "priceDifferenceBPS",
                  maker_uri AS "makerURI"
              FROM (
                  SELECT
                      order_hash,
                      created_at,
                      -- v2.order
                      "order"#>>'{order,takerToken}' AS taker_token,
                      "order"#>>'{order,makerToken}' AS maker_token,
                      ("order"#>>'{order,takerAmount}')::NUMERIC AS taker_amount,
                      ("order"#>>'{order,makerAmount}')::NUMERIC AS maker_amount,
                      "order"#>>'{order,taker}' AS taker,
                      ll_reject_price_difference_bps
                  FROM public.rfqm_v2_jobs v2
                  WHERE
                      status='failed_last_look_declined' AND
                      chain_id = 137
              ) jobs
              LEFT JOIN (
                  SELECT
                      order_hash,
                      created_at,
                      maker_uri,
                      chain_id
                  FROM public.rfqm_v2_quotes
              ) quotes ON jobs.order_hash = quotes.order_hash
              WHERE chain_id = 137
              ORDER BY quotes.created_at DESC
          );
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
          DROP VIEW public.fast_last_look_rejections_polygon;
        `);
    }
}