import { GraphqlQueryError } from "@shopify/shopify-api";
import shopify from "./shopify.js";
import mysql from 'mysql';
import dotenv from 'dotenv';
import cron from 'node-cron';
import express from "express";
import cors from 'cors';
dotenv.config();
const app = express();
const port = 4000;
app.use(cors());
app.get('/api/products', (req, res) => {
  const query = 'SELECT * FROM shopifyapi';

  connection.query(query, (error, results) => {
    if (error) {
      console.error('Lỗi khi truy vấn cơ sở dữ liệu:', error);
      res.status(500).json({ error: 'Lỗi máy chủ' });
      return;
    }
    res.json(results);
  });
});
app.listen(port, () => {
  console.log(`Server đang chạy trên cổng ${port}`);
});

const GET_PRODUCTS_QUERY = `
  query getProducts($cursor: String) {
    products(first: 100, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          description
          productType
          status
          images(first: 5) {
            edges {
              node {
                originalSrc
              }
            }
          }
          variants(first: 100) {
            edges {
              node {
                price
                inventoryQuantity
                sku
                selectedOptions {
                  name
                  value
                }
                metafields(first: 4) {
                  edges {
                    node {
                      key
                      value
                      namespace
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const connection = mysql.createConnection({
  host: process.env.MYSQL_HOST,
  port: process.env.MYSQL_PORT,
  user: process.env.MYSQL_USER,
  password: '',
  database: process.env.MYSQL_DATABASE
});

connection.connect((err) => {
  if (err) {
    console.error('Lỗi kết nối đến cơ sở dữ liệu MySQL:', err);
    return;
  }
  console.log('Đã kết nối đến cơ sở dữ liệu MySQL');
});

async function fetchAllProducts(client) {
  let products = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const response = await client.query({
      data: {
        query: GET_PRODUCTS_QUERY,
        variables: { cursor }
      },
    });

    const productEdges = response.body.data.products.edges;
    products = products.concat(productEdges);

    hasNextPage = response.body.data.products.pageInfo.hasNextPage;
    cursor = response.body.data.products.pageInfo.endCursor;
  }

  return products;
}

export async function productGetter(session) {
  const client = new shopify.api.clients.Graphql({ session });

  try {
    const products = await fetchAllProducts(client);
    const skusFromShopify = products.map(product => product.node.variants.edges[0].node.sku);
    const skusFromDatabase = await new Promise((resolve, reject) => {
      connection.query('SELECT sku FROM shopifyapi', (error, results) => {
        if (error) return reject(error);
        resolve(results.map(result => result.sku));
      });
    });
    const deletedSkus = skusFromDatabase.filter(sku => !skusFromShopify.includes(sku));
    if (deletedSkus.length > 0) {
      const deleteSql = `DELETE FROM shopifyapi WHERE sku IN (?)`;
      connection.query(deleteSql, [deletedSkus], (error, result) => {
        if (error) {
          console.error('Lỗi xóa sản phẩm:', error);
          return;
        }
        console.log('Đã xóa các sản phẩm đã bị xóa từ Shopify:', result);
      });
    }

    for (const product of products) {
      const { title, description, images, variants, productType, status } = product.node;
      const imageSrc = images.edges.map(image => image.node.originalSrc);

      const compressedImageUrls = JSON.stringify(imageSrc);
      const url = images.edges[0].node.originalSrc;
      const prices = variants.edges[0].node.price;
      const quantity = variants.edges[0].node.inventoryQuantity;
      const sku = variants.edges[0].node.sku;

      let sizes = new Set();
      let colors = new Set();
      let materials = new Set();

      variants.edges.forEach(variant => {
        variant.node.selectedOptions.forEach(option => {
          switch (option.name) {
            case 'Size':
              sizes.add(option.value);
              break;
            case 'Color':
              colors.add(option.value);
              break;
            case 'Material':
              materials.add(option.value);
              break;
            default:
              break;
          }
        });
      });
      const sizeJson = JSON.stringify([...sizes]);
      const colorJson = JSON.stringify([...colors]);
      const materialJson = JSON.stringify([...materials]);
      const checkSkuSql = `SELECT COUNT(*) AS count FROM shopifyapi WHERE sku = ?`;
      connection.query(checkSkuSql, [sku], async (error, results) => {
        if (error) {
          console.error('Lỗi truy vấn:', error);
          return;
        }
        if (results.length > 0) {
          const dbProduct = results[0];
          const hasChanged = dbProduct.title !== title ||
            dbProduct.description !== description ||
            dbProduct.imageSrc !== compressedImageUrls ||
            dbProduct.prices !== prices ||
            dbProduct.quantity !== quantity ||
            dbProduct.size !== sizeJson ||
            dbProduct.color !== colorJson ||
            dbProduct.material !== materialJson ||
            dbProduct.Category !== productType ||
            dbProduct.status !== status;

          if (hasChanged) {
            const updateProductSql = `
                    UPDATE shopifyapi
                    SET title = ?,
                        description = ?,
                        imageSrc = ?,
                        prices = ?,
                        quantity = ?,
                        size = ?,
                        color = ?,
                        material = ?,
                        Category = ?,
                        status = ?
                    WHERE sku = ?;
                `;
            connection.query(updateProductSql, [title, description, compressedImageUrls, prices, quantity, sizeJson, colorJson, materialJson, productType, status, sku], (error, result) => {
              if (error) {
                console.error('Lỗi cập nhật sản phẩm:', error);
                return;
              }
              console.log('Cập nhật sản phẩm thành công:', result);
            });
          }
        }
      });
      const [skuCheckResult] = await new Promise((resolve, reject) => {
        connection.query(checkSkuSql, [sku], (error, results) => {
          if (error) return reject(error);
          resolve(results);
        });
      });

      if (skuCheckResult.count > 0) {
        console.log(`SKU ${sku} đã tồn tại. Không thêm sản phẩm.`);
        continue;
      }

      const sql = `INSERT INTO shopifyapi (title, description, imageSrc, prices, quantity, sku, size, color, material, Category, status,url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?)`;
      const values = [title, description, compressedImageUrls, prices, quantity, sku, sizeJson, colorJson, materialJson, productType, status, url];

      connection.query(sql, values, (error, result) => {
        if (error) {
          console.error('Lỗi chèn sản phẩm:', error);
          return;
        }
        console.log('Chèn sản phẩm thành công:', result);
      });
    }

    return products;
  } catch (error) {
    if (error instanceof GraphqlQueryError) {
      throw new Error(
        `${error.message}\n${JSON.stringify(error.response, null, 2)}`
      );
    } else {
      throw error;
    }
  }
}

cron.schedule('57 15 * * *', async () => {
  try {
    const session = {
      shop: process.env.SHOPIFY_SHOP,
      apiKey: process.env.SHOPIFY_API_KEY,
      apiSecret: process.env.SHOPIFY_API_SECRET,
      shop: process.env.SHOPIFY_SHOP,
      accessToken: process.env.SHOPIFY_ACCESS_TOKEN
    };

    await productGetter(session);
    console.log('Đồng bộ hóa sản phẩm thành công!');
  } catch (error) {
    console.error('Lỗi đồng bộ hóa sản phẩm:', error);
  }
});
